// Exercises the REAL src/index.js worker logic directly in Node, using a
// mock KV namespace. This covers the actual username/password login route,
// signed-session-cookie creation/verification, and the admin routes'
// enforcement of that session — all real code paths, not reimplementations.
import worker from "./src/index.js";

function makeKV(initial) {
  let store = initial ? { items: JSON.stringify(initial) } : {};
  return {
    async get(key) {
      return store[key] ?? null;
    },
    async put(key, value) {
      store[key] = value;
    },
  };
}

let assetsFetchCalled = false;
const env = {
  IMPORTS_KV: makeKV(),
  ADMIN_USERNAME: "jonathan",
  ADMIN_PASSWORD: "correct-horse-battery-staple",
  SESSION_SECRET: "a-random-session-signing-secret-for-tests",
  ASSETS: {
    async fetch(req) {
      assetsFetchCalled = true;
      return new Response("<html>static site placeholder</html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });
    },
  },
};

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`PASS: ${name}`);
  } else {
    failed++;
    console.log(`FAIL: ${name}${detail ? " -- " + detail : ""}`);
  }
}

function extractSessionCookie(res) {
  const setCookie = res.headers.get("Set-Cookie") || "";
  const match = setCookie.match(/radar_session=([^;]*)/);
  return match ? match[1] : null;
}

async function run() {
  // 1. Public GET -> no auth needed
  {
    const req = new Request("https://example.com/api/imports", { method: "GET" });
    const res = await worker.fetch(req, env, {});
    const body = await res.json();
    check("public GET -> 200, empty list", res.status === 200 && body.items.length === 0, JSON.stringify(body));
  }

  // 2. Admin POST with no session cookie -> 401
  {
    const req = new Request("https://example.com/api/admin/imports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: [{ id: "x1", title: "T", marca: "Winker", temas: ["a"] }] }),
    });
    const res = await worker.fetch(req, env, {});
    check("admin POST no session -> 401", res.status === 401, `status=${res.status}`);
  }

  // 3. Login with WRONG password -> 401, no cookie set
  {
    const req = new Request("https://example.com/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "jonathan", password: "wrong" }),
    });
    const res = await worker.fetch(req, env, {});
    check("login wrong password -> 401", res.status === 401, `status=${res.status}`);
    check("login wrong password -> no session cookie", !res.headers.get("Set-Cookie"));
  }

  // 4. Login with WRONG username -> 401
  {
    const req = new Request("https://example.com/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "someone-else", password: "correct-horse-battery-staple" }),
    });
    const res = await worker.fetch(req, env, {});
    check("login wrong username -> 401", res.status === 401, `status=${res.status}`);
  }

  // 5. Login with CORRECT credentials -> 200, session cookie set
  let sessionCookie;
  {
    const req = new Request("https://example.com/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "jonathan", password: "correct-horse-battery-staple" }),
    });
    const res = await worker.fetch(req, env, {});
    sessionCookie = extractSessionCookie(res);
    check("login correct credentials -> 200", res.status === 200, `status=${res.status}`);
    check("login correct credentials -> session cookie set", !!sessionCookie);
    check("session cookie -> HttpOnly + Secure flags present", (res.headers.get("Set-Cookie") || "").includes("HttpOnly") && (res.headers.get("Set-Cookie") || "").includes("Secure"));
  }

  // 6. Admin POST WITH the session cookie -> 200, item saved + tagged with username
  {
    const req = new Request("https://example.com/api/admin/imports", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: `radar_session=${sessionCookie}` },
      body: JSON.stringify({ items: [{ id: "x1", title: "Teste import", marca: "Winker", temas: ["seguranca"] }] }),
    });
    const res = await worker.fetch(req, env, {});
    const body = await res.json();
    check("admin POST with valid session -> 200", res.status === 200, `status=${res.status}`);
    check("admin POST with valid session -> item saved", body.items.some((i) => i.id === "x1"), JSON.stringify(body));
    check("admin POST with valid session -> tagged with username", body.items.find((i) => i.id === "x1").importedBy === "jonathan", JSON.stringify(body));
  }

  // 7. Public GET again -> item persisted (simulates a reload / another visitor)
  {
    const req = new Request("https://example.com/api/imports", { method: "GET" });
    const res = await worker.fetch(req, env, {});
    const body = await res.json();
    check("public GET after admin POST -> item persisted", body.items.length === 1 && body.items[0].id === "x1", JSON.stringify(body));
  }

  // 8. Admin DELETE WITH valid session -> removes item
  {
    const req = new Request("https://example.com/api/admin/imports?id=x1", {
      method: "DELETE",
      headers: { Cookie: `radar_session=${sessionCookie}` },
    });
    const res = await worker.fetch(req, env, {});
    const body = await res.json();
    check("admin DELETE with valid session -> item removed", body.items.length === 0, JSON.stringify(body));
  }

  // 9. Tampered session cookie (signature mismatch) -> 401
  {
    const tampered = sessionCookie.slice(0, -4) + "xxxx";
    const req = new Request("https://example.com/api/admin/imports", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: `radar_session=${tampered}` },
      body: JSON.stringify({ items: [{ id: "x2", title: "T", marca: "Winker", temas: ["a"] }] }),
    });
    const res = await worker.fetch(req, env, {});
    check("admin POST with tampered session -> 401", res.status === 401, `status=${res.status}`);
  }

  // 10. Expired session token -> rejected
  {
    const expiredEnv = { ...env };
    // Build an already-expired token the same way the real code does, by
    // temporarily monkey-patching Date.now would be fragile; instead craft
    // one by hand using the same HMAC the module would produce is not
    // exposed, so we approximate by using a token whose expiry field is in
    // the past but otherwise well-formed, then checking it's rejected for
    // *some* reason (signature OR expiry) — either way, access must be denied.
    const fakeExpiredPayload = `${Buffer.from("jonathan").toString("base64")}.1`;
    const req = new Request("https://example.com/api/admin/imports", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: `radar_session=${fakeExpiredPayload}.fakesignature` },
      body: JSON.stringify({ items: [{ id: "x3", title: "T", marca: "Winker", temas: ["a"] }] }),
    });
    const res = await worker.fetch(req, env, {});
    check("admin POST with expired/malformed session -> 401", res.status === 401, `status=${res.status}`);
  }

  // 11. Logout clears the cookie
  {
    const req = new Request("https://example.com/api/logout", { method: "POST" });
    const res = await worker.fetch(req, env, {});
    const setCookie = res.headers.get("Set-Cookie") || "";
    check("logout -> 200", res.status === 200, `status=${res.status}`);
    check("logout -> clears cookie (Max-Age=0)", setCookie.includes("Max-Age=0"), setCookie);
  }

  // 12. Non-API route -> falls through to ASSETS.fetch
  {
    assetsFetchCalled = false;
    const req = new Request("https://example.com/", { method: "GET" });
    const res = await worker.fetch(req, env, {});
    const text = await res.text();
    check("non-API route -> ASSETS.fetch called", assetsFetchCalled === true);
    check("non-API route -> static html returned", text.includes("static site placeholder"), text.slice(0, 50));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run();
