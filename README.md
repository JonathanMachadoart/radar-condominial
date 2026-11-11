# Radar Condominial — Cloudflare Worker (com backend real)

Esta é a versão do site com um backend de verdade: um Cloudflare Worker que serve o site estático **e** uma API (`/api/imports`) apoiada em KV, para que o botão **Importar conteúdo** salve os dados permanentemente — sobrevivendo a reload, a qualquer visitante, em qualquer navegador. Isso substitui a versão anterior (`radar-condominial/`), cujo botão de importar só funcionava na aba atual.

## Estrutura

```
cf-worker/
├── public/
│   └── index.html       ← o site (grafo D3, filtros, importar conteúdo)
├── src/
│   └── index.js         ← o Worker: roteia /api/imports e serve o resto como arquivo estático
├── wrangler.toml         ← configuração do Worker
├── test_worker_logic.mjs ← teste automatizado da lógica do Worker (ver "Testes" abaixo)
└── package.json
```

## O que mudou em relação à versão estática

- Assim que a página carrega, a barra de ferramentas mostra um botão **Entrar** (perto do botão de importar). Clicar nele abre um formulário de **usuário e senha de verdade** (campo de senha mascarado, não uma caixinha simples do navegador). Depois de logado, aparece "Logado como `<usuário>`" com uma opção de **Sair**, e importar conteúdo dali em diante não interrompe mais pedindo login — a sessão dura 7 dias.
- Se você for direto pro botão **Importar conteúdo** sem logar antes, ele pede login no meio do processo (igual antes), e retoma a importação sozinho assim que você entra.
- A senha nunca é guardada pelo código do site — ela só existe como segredo do Worker (`wrangler secret put`), que a Cloudflare guarda criptografado e nem você nem eu conseguimos ver de novo depois de configurado, só trocar.
- Ao abrir a página, ela faz um `GET` em `/api/imports` (sem precisar de login) e mescla os itens já salvos com os dados originais, **antes** de desenhar o grafo — então qualquer visitante já vê tudo que foi importado antes, não só quem importou, e **não precisa logar só para ver o site**. Só salvar/remover é que exige estar logado.

> **Se você já tinha publicado a versão anterior** (com a senha única via `IMPORT_SECRET`): essa versão nova troca completamente esse mecanismo por usuário+senha. Siga o passo 4 abaixo para configurar as novas credenciais antes de publicar de novo — o `IMPORT_SECRET` antigo fica sem uso (pode deixar ou remover com `npx wrangler secret delete IMPORT_SECRET`, tanto faz).
>
> **Se você já tinha publicado a versão com usuário+senha** (sem o botão "Entrar" na barra de ferramentas) e só quer a versão mais nova com login logo ao entrar no site: os três segredos (`ADMIN_USERNAME`, `ADMIN_PASSWORD`, `SESSION_SECRET`) continuam os mesmos, nada muda neles — é só pular direto pro passo 5 (`npx wrangler deploy`) com os arquivos novos.

## Passo a passo para publicar

Importante: não tenho acesso à sua conta Cloudflare neste ambiente — os comandos abaixo você roda na sua própria máquina (com Node instalado), na pasta `cf-worker/` depois de extrair o arquivo que te enviei.

### 0. Primeiro, uma pergunta que eu não consegui confirmar

O arquivo `wrangler.toml` está configurado com `name = "radarcondominial"`, assumindo que é o mesmo nome do Worker que já está publicado em `radarcondominial.jonathan-machadolopes.workers.dev`. **Confira isso antes de rodar `wrangler deploy`:**

```bash
npx wrangler deployments list
```

Se esse comando listar deployments do Worker `radarcondominial`, o nome está certo e o deploy abaixo vai **atualizar o mesmo Worker** (mesma URL). Se dar erro de "not found" ou mostrar outro nome, me diga qual é o nome certo (ou veja em dash.cloudflare.com → Workers & Pages) e ajuste a linha `name = "..."` no `wrangler.toml` antes de continuar.

### 1. Instalar dependências

```bash
npm install
```

### 2. Autenticar com sua conta Cloudflare (se ainda não estiver)

```bash
npx wrangler login
```

### 3. Criar (ou reaproveitar) o namespace do KV

Se você **ainda não tem** um KV namespace para este projeto:

```bash
npx wrangler kv namespace create IMPORTS_KV
```

Isso imprime algo como:

```
{ binding = "IMPORTS_KV", id = "abcd1234..." }
```

Copie esse `id` e cole em `wrangler.toml`, substituindo `REPLACE_WITH_YOUR_KV_NAMESPACE_ID`:

```toml
[[kv_namespaces]]
binding = "IMPORTS_KV"
id = "abcd1234..."
```

Se você **já tinha criado** um KV namespace para este Worker antes (por exemplo, numa tentativa anterior), rode `npx wrangler kv namespace list` para achar o `id` existente e reaproveite-o, em vez de criar um novo — assim você não perde nada que já esteja lá.

### 4. Definir o usuário, a senha e o segredo de sessão

São três segredos do Worker, cada um com seu próprio comando. Rode um de cada vez — ele vai pedir para você digitar o valor (não aparece na tela, por segurança):

```bash
npx wrangler secret put ADMIN_USERNAME
```
(escolha um nome de usuário, por exemplo `jonathan`)

```bash
npx wrangler secret put ADMIN_PASSWORD
```
(escolha uma senha — é a mesma que você vai digitar no site quando for importar algo)

```bash
npx wrangler secret put SESSION_SECRET
```
(esse não é algo que você vai digitar depois — é só uma chave aleatória usada internamente pelo Worker para assinar a sessão de quem está logado. Pode colar qualquer texto longo e aleatório aqui, por exemplo gerado com `openssl rand -hex 32` no terminal, ou simplesmente uma frase longa qualquer que só você conhece.)

### 5. Publicar

```bash
npx wrangler deploy
```

Se tudo correr bem, ele confirma a URL publicada — deve ser a mesma `radarcondominial.jonathan-machadolopes.workers.dev` de antes (ou a que você corrigiu no passo 0).

### 6. Testar

1. Abra o site publicado (dê um Ctrl+Shift+R pra garantir que não está vendo uma versão em cache).
2. Na barra de ferramentas, clique em **Entrar** e faça login com o usuário/senha do passo 4. Deve trocar para "Logado como `<usuário>` · Sair".
3. Clique em **Importar conteúdo**, suba um `.md` ou `.zip`, revise e confirme — como você já está logado, deve salvar direto, sem pedir login de novo.
4. Recarregue a página (F5) — o item importado deve continuar aparecendo, e o botão de login deve voltar a mostrar "Entrar" (a sessão não é "lembrada" entre recargas de página nesse sentido — ela é um cookie, então continua logada; o que reseta é só o estado inicial sendo checado de novo via `/api/me`, que deve te manter logado automaticamente). Esse é o sinal de que a persistência real está funcionando (na versão estática antiga, ele desaparecia ao recarregar).
5. Abra o site em outro navegador ou aba anônima — o item importado deve aparecer também lá (sem precisar logar, já que ver o conteúdo é público), e o botão deve mostrar "Entrar" (sessão de login não é compartilhada entre navegadores/dispositivos, como esperado), confirmando que o conteúdo está salvo no servidor, não só no seu navegador.
6. Pra sair, clique em **Sair** na barra de ferramentas.

## Testes automatizados incluídos

Este ambiente de desenvolvimento não teve acesso de rede para rodar `wrangler dev` de verdade (ele precisa falar com `workers.cloudflare.com`), então a lógica do Worker (`src/index.js`) foi testada rodando o próprio arquivo direto no Node, com um KV simulado — ou seja, testando o código real que será publicado, não uma reimplementação. Para rodar você mesmo:

```bash
node test_worker_logic.mjs
```

Os 21 casos cobrem: `GET` público sem login, `POST` administrativo sem sessão (401), login com senha errada (401, sem cookie), login com usuário errado (401), login correto (200, cookie de sessão com `HttpOnly`+`Secure`), `POST` com sessão válida (salva e marca quem importou), persistência entre chamadas (simula reload), `DELETE` com sessão válida, cookie de sessão adulterado (401 — a assinatura não bate), sessão expirada/malformada (401), logout (limpa o cookie), `GET /api/me` sem e com sessão válida, rota estática (cai para `ASSETS.fetch`).

Separadamente, o fluxo completo da página (`index.html` real, servido por HTTP local, com as chamadas de rede interceptadas e respondendo como o Worker responde) foi validado ponta a ponta: a barra de ferramentas mostra "Entrar" quando não logado; logar pelo botão do topo funciona (credenciais erradas mostram aviso, certas logam e trocam o botão por "Logado como ... · Sair"); depois de logado assim, importar não interrompe mais pedindo login; sair pelo botão "Sair" volta ao estado "Entrar"; e um carregamento novo da página, mesmo sem login nenhum, já vem com o item importado antes — confirmando que ver o conteúdo continua público, só salvar exige login.

## Removendo um item importado (se precisar)

O Worker também aceita `DELETE /api/admin/imports?id=<id>`, com a mesma sessão de login, caso você queira remover algo importado por engano. Não há botão para isso na interface ainda — se for algo que você vai precisar com frequência, posso adicionar um botão de remover na própria tela, me avise.

## Trocando a senha depois

Se um dia quiser trocar o usuário ou a senha, é só rodar de novo o comando do passo 4 correspondente (`npx wrangler secret put ADMIN_USERNAME` ou `ADMIN_PASSWORD`) com o novo valor e publicar de novo (`npx wrangler deploy`). Sessões já abertas com o login antigo continuam válidas até expirarem (7 dias) ou até você trocar também o `SESSION_SECRET`, que invalida todas de uma vez.

## Sobre a versão no claude.ai

O artefato publicado no claude.ai (o link que abre direto no Claude) continua funcionando à parte, com o próprio banco de dados do artefato — não depende deste Worker. As duas versões agora têm bases de dados de importação separadas: o que você importar em uma não aparece na outra.
