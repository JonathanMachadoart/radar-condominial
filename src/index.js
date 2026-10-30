const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const SESSION_COOKIE = "radar_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function json(data, init) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS, ...(init && init.headers) },
  });
}

function timingSafeEqual(a, b) {
  a = String(a);
  b = String(b);
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

function base64url(bytesOrStr) {
  let bin;
  if (typeof bytesOrStr === "string") {
    bin = bytesOrStr;
  } else {
    bin = String.fromCharCode(...new Uint8Array(bytesOrStr));
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmacSign(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return base64url(sig);
}

// Session tokens are self-contained and signed (HMAC-SHA256 with
// SESSION_SECRET), not looked up in KV — so logging in doesn't need a
// storage write, and the token simply stops working once it expires.
async function createSessionToken(env, username) {
  const expiry = Date.now() + SESSION_TTL_MS;
  const payload = `${base64url(username)}.${expiry}`;
  const sig = await hmacSign(env.SESSION_SECRET, payload);
  return `${payload}.${sig}`;
}

async function verifySessionToken(env, token) {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [userB64, expiryStr, sig] = parts;
  const expiry = Number(expiryStr);
  if (!expiry || Date.now() > expiry) return null;
  const expectedSig = await hmacSign(env.SESSION_SECRET, `${userB64}.${expiryStr}`);
  if (!timingSafeEqual(sig, expectedSig)) return null;
  try {
    return atob(userB64.replace(/-/g, "+").replace(/_/g, "/"));
  } catch (e) {
    return null;
  }
}

function getCookie(request, name) {
  const cookieHeader = request.headers.get("Cookie") || "";
  const match = cookieHeader.match(new RegExp("(?:^|;\\s*)" + name + "=([^;]*)"));
  return match ? decodeURIComponent(match[1]) : null;
}

function sessionCookieHeader(token) {
  return `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}; Path=/`;
}

function clearSessionCookieHeader() {
  return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Path=/`;
}

async function getItems(env) {
  const raw = await env.IMPORTS_KV.get("items");
  return raw ? JSON.parse(raw) : [];
}

async function putItems(env, items) {
  await env.IMPORTS_KV.put("items", JSON.stringify(items));
}

// Public: anyone visiting the site needs this to see the same content
// everyone else sees, so it stays open — no login required to read.
async function handlePublicImports(request, env) {
  if (request.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (request.method !== "GET") return json({ error: "method not allowed" }, { status: 405 });
  const items = await getItems(env);
  return json({ items });
}

async function handleLogin(request, env) {
  if (request.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (request.method !== "POST") return json({ error: "method not allowed" }, { status: 405 });

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: "invalid json" }, { status: 400 });
  }

  const username = String((body && body.username) || "");
  const password = String((body && body.password) || "");
  const validUser = env.ADMIN_USERNAME || "";
  const validPass = env.ADMIN_PASSWORD || "";

  if (!validUser || !validPass || !timingSafeEqual(username, validUser) || !timingSafeEqual(password, validPass)) {
    return json({ error: "invalid credentials" }, { status: 401 });
  }

  const token = await createSessionToken(env, username);
  return json({ ok: true }, { headers: { "Set-Cookie": sessionCookieHeader(token) } });
}

async function handleLogout(request, env) {
  if (request.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  return json({ ok: true }, { headers: { "Set-Cookie": clearSessionCookieHeader() } });
}

// Protected by a real username + password login (see handleLogin above).
// The password itself is never stored by this code — it only ever lives as
// a Cloudflare Worker secret (set via `wrangler secret put`), which
// Cloudflare encrypts at rest and never exposes back, not even to us.
async function handleAdminImports(request, env) {
  if (request.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

  const token = getCookie(request, SESSION_COOKIE);
  const username = await verifySessionToken(env, token);
  if (!username) {
    return json({ error: "not authenticated" }, { status: 401 });
  }

  if (request.method === "POST") {
    let body;
    try {
      body = await request.json();
    } catch (e) {
      return json({ error: "invalid json" }, { status: 400 });
    }

    const newItems = Array.isArray(body && body.items) ? body.items : [];
    if (!newItems.length) {
      return json({ error: "no items" }, { status: 400 });
    }

    const existing = await getItems(env);
    const existingIds = new Set(existing.map((c) => c && c.id));

    newItems.forEach((item) => {
      if (item && typeof item.id === "string" && item.title && item.marca && Array.isArray(item.temas) && !existingIds.has(item.id)) {
        item.importedBy = username;
        existing.push(item);
        existingIds.add(item.id);
      }
    });

    await putItems(env, existing);
    return json({ items: existing });
  }

  if (request.method === "DELETE") {
    const url = new URL(request.url);
    const id = url.searchParams.get("id");
    if (!id) return json({ error: "missing id" }, { status: 400 });

    const existing = await getItems(env);
    const filtered = existing.filter((c) => c && c.id !== id);
    await putItems(env, filtered);
    return json({ items: filtered });
  }

  return json({ error: "method not allowed" }, { status: 405 });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/imports") return handlePublicImports(request, env);
    if (url.pathname === "/api/login") return handleLogin(request, env);
    if (url.pathname === "/api/logout") return handleLogout(request, env);
    if (url.pathname === "/api/admin/imports") return handleAdminImports(request, env);

    // Everything else is the static site (index.html and friends).
    return env.ASSETS.fetch(request);
  },
};
