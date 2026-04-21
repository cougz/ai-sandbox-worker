# AI Sandbox

A multi-user AI coding sandbox deployed on Cloudflare Workers. Exposes two ways to interact with the same set of tools:

- **`/chat`** — Browser-based OpenCode web UI running inside a Cloudflare Container per user, powered by **Kimi K2.6 via Workers AI** (default) with switchable models. No local setup required.
- **`/mcp`** — MCP server for any external MCP-compatible client (OpenCode TUI, Claude Desktop, Cursor, etc.) connecting over HTTPS with OAuth.

Both interfaces use the same execution primitives, the same persistent workspace, and the same custom tools. Adding a tool via `/chat` makes it immediately available in a local OpenCode session, and vice versa.

Built on Cloudflare-native primitives:

- **[Dynamic Workers](https://developers.cloudflare.com/dynamic-workers/)** — isolated V8 sandbox per `run_code` call (~2ms startup), no shared state between executions
- **[Code Mode (`@cloudflare/codemode`)](https://developers.cloudflare.com/agents/api-reference/codemode/)** — the LLM writes a JavaScript function that orchestrates multiple tools with real logic; runs inside the sandbox; tool calls dispatched back to the host via Workers RPC
- **[Cloudflare Containers](https://developers.cloudflare.com/containers/)** — one container per user for `/chat`, runs `opencode serve` with the Workers AI provider and the MCP server pre-configured

---

## Table of Contents

- [Architecture](#architecture)
- [Prerequisites](#prerequisites)
- [One-time infrastructure setup](#one-time-infrastructure-setup)
- [Cloudflare Access setup](#cloudflare-access-setup)
- [Secrets](#secrets)
- [CI/CD](#cicd)
- [Deploy](#deploy)
- [Chat interface (`/chat`)](#chat-interface-chat)
- [MCP interface (`/mcp`)](#mcp-interface-mcp)
- [Dashboard (`/dash`)](#dashboard-dash)
- [MCP tools](#mcp-tools)
- [Adding domain tools](#adding-domain-tools)
- [Report generation](#report-generation)

---

## Architecture

```
Browser (/chat)               OpenCode TUI / MCP client
      │                                  │
      │  HTTPS + CF Access               │  MCP over HTTPS (OAuth 2.0)
      ▼                                  ▼
┌─────────────────────────────────────────────────────────┐
│                   Cloudflare Worker                     │
│                                                         │
│  /chat          → serves OpenCode embed page            │
│  /chat/oc/*     → proxy to container port 4096          │
│  /chat/oauth/*  → MCP OAuth callback proxy              │
│  /chat/ai/v1/*  → Workers AI proxy (env.AI binding)     │
│  /chat/api/*    → config & MCP status API               │
│  /opencode-ui/* → static assets (JS/CSS bundle)        │
│                                                         │
│  /mcp           → SandboxAgent DO (MCP protocol)        │
│  /authorize     → Cloudflare Access OIDC                │
│  /callback      → Access OIDC callback                  │
│  /view          → public workspace file server          │
│  /dash          → admin/user dashboard                  │
└──────────────────────────┬──────────────────────────────┘
                           │
           ┌───────────────┴────────────────┐
           │                                │
           ▼                                ▼
   ChatSession DO                    SandboxAgent DO
   (one per user)                    (one per MCP session)
           │                                │
           ▼                                │
   Cloudflare Container                     │
   (standard-2 per user)                   │
   └─ opencode serve :4096                 │
      ├─ provider: Workers AI              │
      └─ mcp: ai-sandbox (/mcp) ──────────►│
                                           │
                               DynamicWorkerExecutor
                               (isolated V8 sandbox)
                                           │
                    ┌──────────────────────┼──────────────┐
                    ▼                      ▼              ▼
              D1 (workspace)        R2 (storage)    KV (OAuth/users)
```

---

## Prerequisites

- Cloudflare account on the **Workers Paid plan** (Dynamic Worker Loader requires it)
- Node.js 18+
- Wrangler CLI: `npm install -g wrangler`

---

## One-time infrastructure setup

### 1. KV namespace

`OAUTH_KV` and `USER_REGISTRY` share one namespace (key prefixes don't collide):

```bash
wrangler kv namespace create USER_REGISTRY
# → paste the output ID for both OAUTH_KV and USER_REGISTRY in wrangler.jsonc
```

### 2. D1 workspace database

```bash
wrangler d1 create sandbox-workspaces
# → paste the database_id into wrangler.jsonc under WORKSPACE_DB
```

### 3. R2 bucket

```bash
wrangler r2 bucket create sandbox-storage
```

### 4. Update `wrangler.jsonc`

Replace the KV ID and D1 ID placeholders with the values from steps 1–2.

---

## Cloudflare Access setup

The sandbox uses **two independent Access applications** — one for the browser UI, one for the MCP OAuth flow. They serve different purposes and can coexist on the same domain.

### Application 1 — Browser UI (self-hosted)

Protects `/dash` and `/chat` in the browser. Standard CF Access: user visits the URL, Access checks their session, injects `cf-access-authenticated-user-email` header.

**Zero Trust → Access → Applications → Add → Self-hosted**

| Field | Value |
|---|---|
| Application name | `AI Sandbox` |
| Domain | `your-domain.com` |
| Path | *(leave blank to protect the whole domain)* |

Add an **Allow** policy (emails ending in `@yourcompany.com`, or specific emails).

Then add **Bypass** policies for the paths that must be reachable without a browser session:

| Path | Reason |
|---|---|
| `/view*` | Public report links — intentionally unauthenticated |
| `/chat/oauth/*` | MCP OAuth callbacks from the container |
| `/chat/ai/*` | Workers AI proxy called by the container |
| `/mcp*` | MCP protocol — has its own OAuth flow |
| `/authorize*` | MCP OAuth start |
| `/callback*` | MCP OAuth callback |
| `/token*` | MCP OAuth token exchange |
| `/register*` | MCP client registration |

> **Tip:** If you prefer to protect only specific paths rather than the whole domain, create separate self-hosted applications for `/dash*` and `/chat*` each with an Allow policy.

### Application 2 — MCP OAuth (SaaS / OIDC)

Required only for the **`/mcp` endpoint** — i.e. when connecting external MCP clients like OpenCode TUI or Claude Desktop. Not needed if you only use `/chat`.

**Zero Trust → Access → Applications → Add → SaaS**

| Field | Value |
|---|---|
| Application name | `AI Sandbox MCP` |
| Application type | `OIDC` |
| Redirect URL | `https://your-domain.com/callback` |
| Scopes | `openid`, `email`, `profile` |

Save and note the values shown:

| Secret | Where to find it |
|---|---|
| `ACCESS_CLIENT_ID` | Client ID |
| `ACCESS_CLIENT_SECRET` | Client secret |
| `ACCESS_TOKEN_URL` | Token endpoint |
| `ACCESS_AUTHORIZATION_URL` | Authorization endpoint |
| `ACCESS_JWKS_URL` | Key endpoint |

Add the same **Allow** policy as Application 1.

> **If you only use `/chat`** and never connect external MCP clients, you can skip Application 2 entirely and leave the `ACCESS_*` secrets unset.

---

## Secrets

Set via `wrangler secret put <name>` after the first deploy.

| Secret | Required | Description |
|---|---|---|
| `ADMIN_EMAILS` | Yes | Comma-separated admin email addresses. Admins see the full dashboard; all other authenticated users see a limited view. |
| `COOKIE_ENCRYPTION_KEY` | Yes | Random string for signing session cookies. Generate: `openssl rand -hex 32` |
| `ACCESS_CLIENT_ID` | MCP only | From Access for SaaS OIDC app (Application 2) |
| `ACCESS_CLIENT_SECRET` | MCP only | From Access for SaaS OIDC app |
| `ACCESS_TOKEN_URL` | MCP only | From Access for SaaS OIDC app |
| `ACCESS_AUTHORIZATION_URL` | MCP only | From Access for SaaS OIDC app |
| `ACCESS_JWKS_URL` | MCP only | From Access for SaaS OIDC app |

**Quick setup:**
```bash
wrangler secret put ADMIN_EMAILS          # e.g. alice@example.com,bob@example.com
wrangler secret put COOKIE_ENCRYPTION_KEY # openssl rand -hex 32
# If using /mcp with external clients:
wrangler secret put ACCESS_CLIENT_ID
wrangler secret put ACCESS_CLIENT_SECRET
wrangler secret put ACCESS_TOKEN_URL
wrangler secret put ACCESS_AUTHORIZATION_URL
wrangler secret put ACCESS_JWKS_URL
```

---

## CI/CD

Deployment is split across two systems because Workers Builds (Cloudflare's CI/CD) runs in a K8s environment without Docker and therefore cannot build container images.

### Workers Builds — Worker code + OpenCode UI bundle

Triggered on every push to `main`. Configure in the Cloudflare dashboard under **Workers & Pages → your worker → Settings → Build & Deploy**:

| Setting | Value |
|---|---|
| Build command | `npm run build-ui` |
| Deploy command | `node scripts/patch-container-image.js && npx wrangler deploy --config wrangler.deploy.json` |

`build-ui` clones the OpenCode repo at the pinned commit (`public/opencode-ui/VERSION`), builds the SolidJS mount bundle with Vite, and outputs it to `public/opencode-ui/` where Wrangler picks it up via the `assets` binding.

`patch-container-image.js` replaces the local `./Dockerfile` reference in the config with the latest `ai-sandbox-chat` tag from the Cloudflare container registry, then writes `wrangler.deploy.json` for the deploy step.

### GitHub Actions — Container image

Triggered automatically on push to `main` when `Dockerfile` or `chat-config/` changes. Uses a GitHub-hosted `ubuntu-latest` runner (Docker pre-installed).

**Required GitHub Actions secret** (Settings → Secrets and variables → Actions → Secrets):

| Name | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | API token with **Workers Containers: Edit** permission |

The account ID is read from `wrangler.jsonc` automatically — no variable needed.

To trigger a rebuild without changing files, go to **Actions → Build & Push Container Image → Run workflow**.

> The container image must exist in the registry before the first Workers Builds deploy succeeds. Either push a code change that modifies `Dockerfile` or `chat-config/`, or trigger the workflow manually.

---

## Deploy

```bash
npm install
wrangler deploy      # local deploy (requires Docker for the container image build)
```

For subsequent deploys, use Workers Builds (automatic) or:

```bash
npm run build-ui
node scripts/patch-container-image.js
wrangler deploy --config wrangler.deploy.json
```

---

## Chat interface (`/chat`)

### Accessing the chat

Visit `https://your-domain.com/chat`. Cloudflare Access will authenticate you (One-Time PIN, Google, or your configured IdP). Once logged in you land directly in the OpenCode web UI.

On first load the Worker starts the OpenCode container for your user in the background. This takes ~10–15 seconds on a cold start; the UI shows a loading state until the server is ready.

### What you get

- **Full OpenCode web UI** — same conversation interface as running `opencode web` locally
- **Kimi K2.6** (262K context) as the default model, via Workers AI — no API key required
- **All MCP tools** auto-connected — `run_code`, `run_bundled_code`, `get_url`, `tool_create`, `tool_list`, `tool_delete`, `tool_reload`, plus any custom tools you or your team have created
- **Persistent workspace** — the same D1-backed workspace as the MCP interface; files written in `/chat` are readable via `/mcp` and vice versa

### Switching models

Open **Settings** in the OpenCode UI and change the model. Available options:

| Model ID | Display name |
|---|---|
| `@cf/moonshotai/kimi-k2.6` | Kimi K2.6 (default, 262K ctx) |
| `@cf/meta/llama-4-scout-17b-16e-instruct` | Llama 4 Scout 17B |
| `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | Llama 3.3 70B |
| `@cf/qwen/qwen3-235b-a22b` | Qwen3 235B |
| `@cf/openai/gpt-oss-120b` | GPT-OSS 120B |
| `@cf/deepseek-ai/deepseek-r1-distill-llama-70b` | DeepSeek R1 Distill 70B |

All models are served via **Workers AI** — billed to the same Cloudflare account as the Worker, no separate API keys.

### Adding MCP servers

Open **Settings → MCP** in the OpenCode UI to add additional remote MCP servers. The `ai-sandbox` server is pre-configured and cannot be removed.

### MCP authentication

On first use, the `ai-sandbox` MCP server shows as `needs_auth`. The OpenCode UI will prompt you to authenticate — this opens the standard Cloudflare Access login flow in a new tab. After authenticating once, the token is stored in the container and subsequent sessions connect automatically.

---

## MCP interface (`/mcp`)

For connecting external MCP clients (OpenCode TUI, Claude Desktop, Cursor, etc.).

### OpenCode TUI

Add to `opencode.jsonc`:

```jsonc
{
  "mcp": {
    "ai-sandbox": {
      "type": "remote",
      "url": "https://your-domain.com/mcp"
    }
  }
}
```

Authenticate once:

```bash
opencode mcp auth ai-sandbox
```

A browser window opens → Cloudflare Access login → token saved to `~/.local/share/opencode/mcp-auth.json` → all future sessions are automatic.

### Claude Desktop / other clients

Add to `claude_desktop_config.json` (or equivalent):

```json
{
  "mcpServers": {
    "ai-sandbox": {
      "type": "streamable-http",
      "url": "https://your-domain.com/mcp"
    }
  }
}
```

The first request will redirect to the OAuth flow.

---

## Dashboard (`/dash`)

Visit `https://your-domain.com/dash`. Role is determined server-side by checking your email against the `ADMIN_EMAILS` secret.

| Section | Admin | User |
|---|---|---|
| Users — list, provision, wipe workspaces | ✓ | — |
| Tools — view built-in and custom tools | ✓ | ✓ |
| Files — browse workspaces | All users | Own only |
| Logs — structured Worker events (7-day TTL) | ✓ | — |
| My Account — email, first login, file count | ✓ | ✓ |

---

## MCP tools

### `run_code`

Execute JavaScript in an isolated V8 sandbox (~2ms startup). The LLM writes an async function using **Code Mode** — it can chain tool calls with real logic (conditionals, loops, error handling) rather than issuing them one at a time:

```js
async () => {
  const raw = await codemode.kvGet({ key: "pipeline-data" });
  const parsed = JSON.parse(raw);
  const failures = parsed.runs.filter(r => r.status === "failed");
  await state.writeFile("/reports/failures.json", JSON.stringify(failures, null, 2));
  return failures.length;
}
```

Available namespaces inside the sandbox:

| Namespace | Description |
|---|---|
| `state.*` | User workspace: `readFile`, `writeFile`, `glob`, `searchFiles`, `replaceInFiles`, `diff`, and more — persisted in D1 |
| `shared.*` | Team shared workspace — same API as `state.*`, shared across all users |
| `codemode.*` | Domain tools defined in `src/tools/example.ts` — runs in the host Worker with full binding access |

### `run_bundled_code`

Same as `run_code` but bundles npm packages at runtime so the sandbox can `import` them. Slower — prefer `run_code` for tasks that don't need external packages.

### `get_url`

Returns a stable, shareable URL for any file in the workspace. The `/view` endpoint is public — no login required.

```
get_url({ file: "/reports/dashboard.html" })
→ https://your-domain.com/view?user=alice@example.com&file=/reports/dashboard.html
```

### `tool_create` / `tool_list` / `tool_delete` / `tool_reload`

Create, list, delete, and reload custom JavaScript tools stored in the workspace. Custom tools persist across sessions and are available in both the `/chat` and `/mcp` interfaces.

```
tool_create({
  name: "fetch_jira",
  description: "Fetch a Jira ticket by key",
  schema: { key: { type: "string", description: "Jira ticket key e.g. PROJ-123" } },
  code: `async ({ key }) => {
    const resp = await fetch("https://jira.example.com/rest/api/2/issue/" + key, {
      headers: { Authorization: "Bearer " + await state.readFile("/secrets/jira-token") }
    });
    return resp.json();
  }`
})
```

---

## Adding domain tools

Edit `src/tools/example.ts` to replace the stub with calls to your real services:

```typescript
export const domainTools = {
  myQuery: {
    description: "Query my database",
    execute: async ({ sql }: { sql: string }) => {
      // Runs in the host Worker — full access to env bindings, secrets, external APIs
      return env.MY_D1.prepare(sql).all();
    },
  },
};
```

The LLM calls these as `codemode.myQuery({ sql: "..." })` inside the sandbox via Workers RPC. The sandbox never has direct database access — it only sees return values.

---

## Report generation

```
User: "Analyse the pipeline data and create a dashboard"

→ run_code reads /data/pipeline.json, transforms it, writes /reports/pipeline-dashboard.html
→ get_url returns: https://your-domain.com/view?user=alice@example.com&file=/reports/pipeline-dashboard.html
```

The link works for anyone without login. The LLM can use any approach — self-contained HTML with inline CSS and Chart.js, or reusable templates stored in the workspace.

---

## Bindings reference

| Binding | Type | Purpose |
|---|---|---|
| `WORKSPACE_DB` | D1 | Persistent workspace files per user (namespaced by email) |
| `STORAGE` | R2 | Large file spill-over for workspace files above threshold |
| `OAUTH_KV` | KV | OAuth provider state (client registrations, tokens) |
| `USER_REGISTRY` | KV | User registry — populated automatically on first login |
| `AI` | Workers AI | Kimi K2.6 and other models for `/chat` — no API key |
| `Sandbox` | Container DO | Cloudflare Container per user for `/chat` (standard-2) |
| `CHAT_SESSION` | Durable Object | OpenCode lifecycle management per user |
| `SandboxAgent` | Durable Object | MCP session handler (one per connected client) |
| `LOADER` | Worker Loader | Dynamic Worker sandboxes for `run_code` |
