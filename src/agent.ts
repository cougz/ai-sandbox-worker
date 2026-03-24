import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpAgent } from "agents/mcp";
import { DynamicWorkerExecutor, resolveProvider } from "@cloudflare/codemode";
import { Workspace } from "@cloudflare/shell";
import { stateTools } from "@cloudflare/shell/workers";
import { createWorker } from "@cloudflare/worker-bundler";
import { z } from "zod";
import { domainTools } from "./tools/example";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Env {
  LOADER: WorkerLoader;
  SandboxAgent: DurableObjectNamespace;
  STORAGE?: R2Bucket;
  PUBLIC_URL: string;
  // KV namespace: stores clientId→email and user records
  USER_REGISTRY: KVNamespace;
  // Secret set via: wrangler secret put ADMIN_SECRET
  ADMIN_SECRET?: string;
  // Dev only — never set in production
  DEV_USER_ID?: string;
}

interface UserRecord {
  email: string;
  name: string;
  clientId: string;
  createdAt: string;
}

// ─── Auth helpers ─────────────────────────────────────────────────────────────

/**
 * Resolve the stable user email for a request.
 * Priority:
 *   1. Cf-Access-Authenticated-User-Email (browser login via Cloudflare Access)
 *   2. CF-Access-Client-Id → KV lookup (service token via Cloudflare Access)
 *   3. DEV_USER_ID env var (wrangler dev only — never reaches production)
 */
async function resolveUserEmail(request: Request, env: Env): Promise<string | null> {
  // Browser-based Cloudflare Access login
  const emailHeader = request.headers.get("Cf-Access-Authenticated-User-Email");
  if (emailHeader) return emailHeader;

  // Service token — look up in KV
  const clientId = request.headers.get("CF-Access-Client-Id");
  if (clientId) {
    const email = await env.USER_REGISTRY.get(`client:${clientId}`);
    if (email) return email;
  }

  // Local dev fallback (DEV_USER_ID is set in wrangler.jsonc vars, not as a secret)
  if (env.DEV_USER_ID) return env.DEV_USER_ID;

  return null;
}

function doNameForEmail(email: string): string {
  return `user:${email}`;
}

// ─── Admin auth ───────────────────────────────────────────────────────────────

function isAdminAuthorized(request: Request, env: Env): boolean {
  const key = request.headers.get("X-Admin-Key");
  return !!key && key === env.ADMIN_SECRET;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ─── Admin REST API ───────────────────────────────────────────────────────────

async function handleAdminApi(request: Request, env: Env): Promise<Response> {
  if (!isAdminAuthorized(request, env)) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  const url = new URL(request.url);
  // strip /admin/api prefix
  const path = url.pathname.replace(/^\/admin\/api/, "");
  const method = request.method.toUpperCase();

  // GET /users — list all registered users with file counts
  if (method === "GET" && path === "/users") {
    const list = await env.USER_REGISTRY.list({ prefix: "user:" });
    const users = await Promise.all(
      list.keys.map(async (k) => {
        const record = await env.USER_REGISTRY.get<UserRecord>(k.name, "json");
        if (!record) return null;
        // Fetch file list from the user's DO
        const id = env.SandboxAgent.idFromName(doNameForEmail(record.email));
        const stub = env.SandboxAgent.get(id);
        let files: { path: string; size: number }[] = [];
        try {
          const res = await stub.fetch(
            new Request(`${url.origin}/__admin/files`, { method: "GET" })
          );
          if (res.ok) files = await res.json();
        } catch { /* DO may not exist yet */ }
        return { ...record, fileCount: files.length };
      })
    );
    return jsonResponse(users.filter(Boolean));
  }

  // POST /users — register a new user
  if (method === "POST" && path === "/users") {
    const body = await request.json<{ name: string; email: string; clientId: string }>();
    if (!body.email || !body.clientId) {
      return jsonResponse({ error: "email and clientId are required" }, 400);
    }
    const record: UserRecord = {
      email: body.email,
      name: body.name ?? body.email,
      clientId: body.clientId,
      createdAt: new Date().toISOString(),
    };
    await Promise.all([
      env.USER_REGISTRY.put(`user:${body.email}`, JSON.stringify(record)),
      env.USER_REGISTRY.put(`client:${body.clientId}`, body.email),
    ]);
    return jsonResponse(record, 201);
  }

  // Match /users/:email and /users/:email/...
  const userMatch = path.match(/^\/users\/([^/]+)(\/.*)?$/);
  if (userMatch) {
    const email = decodeURIComponent(userMatch[1]);
    const sub = userMatch[2] ?? "";

    // PUT /users/:email — rotate client token (new clientId, same workspace)
    if (method === "PUT" && sub === "") {
      const body = await request.json<{ clientId: string; name?: string }>();
      const existing = await env.USER_REGISTRY.get<UserRecord>(`user:${email}`, "json");
      if (!existing) return jsonResponse({ error: "User not found" }, 404);
      // Remove old client mapping
      await env.USER_REGISTRY.delete(`client:${existing.clientId}`);
      const updated: UserRecord = {
        ...existing,
        clientId: body.clientId,
        ...(body.name ? { name: body.name } : {}),
      };
      await Promise.all([
        env.USER_REGISTRY.put(`user:${email}`, JSON.stringify(updated)),
        env.USER_REGISTRY.put(`client:${body.clientId}`, email),
      ]);
      return jsonResponse(updated);
    }

    // DELETE /users/:email — remove user from registry (does NOT wipe workspace)
    if (method === "DELETE" && sub === "") {
      const existing = await env.USER_REGISTRY.get<UserRecord>(`user:${email}`, "json");
      if (!existing) return jsonResponse({ error: "User not found" }, 404);
      await Promise.all([
        env.USER_REGISTRY.delete(`user:${email}`),
        env.USER_REGISTRY.delete(`client:${existing.clientId}`),
      ]);
      return jsonResponse({ deleted: email });
    }

    const stub = env.SandboxAgent.get(
      env.SandboxAgent.idFromName(doNameForEmail(email))
    );

    // GET /users/:email/files — list workspace files
    if (method === "GET" && sub === "/files") {
      const res = await stub.fetch(
        new Request(`${url.origin}/__admin/files`, { method: "GET" })
      );
      return res.ok ? jsonResponse(await res.json()) : jsonResponse([], 200);
    }

    // DELETE /users/:email/workspace — wipe entire workspace
    if (method === "DELETE" && sub === "/workspace") {
      await stub.fetch(
        new Request(`${url.origin}/__admin/workspace`, { method: "DELETE" })
      );
      return jsonResponse({ wiped: email });
    }

    // DELETE /users/:email/files?path=... — delete a specific file
    if (method === "DELETE" && sub === "/files") {
      const filePath = url.searchParams.get("path");
      if (!filePath) return jsonResponse({ error: "Missing ?path=" }, 400);
      await stub.fetch(
        new Request(
          `${url.origin}/__admin/files?path=${encodeURIComponent(filePath)}`,
          { method: "DELETE" }
        )
      );
      return jsonResponse({ deleted: filePath });
    }
  }

  return jsonResponse({ error: "Not found" }, 404);
}

// ─── Admin HTML dashboard ─────────────────────────────────────────────────────

function adminDashboard(): Response {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AI Sandbox — Admin</title>
<style>
html{color-scheme:light}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --cf-orange:#FF4801;--cf-text:#521000;--cf-text-muted:rgba(82,16,0,0.7);
  --cf-text-subtle:rgba(82,16,0,0.4);--cf-bg:#FFFBF5;--cf-bg-card:#FFFDFB;
  --cf-bg-hover:#FEF7ED;--cf-border:#EBD5C1;--cf-border-light:rgba(235,213,193,0.5);
  --cf-success:#16A34A;--cf-error:#DC2626;
}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
  background:var(--cf-bg);color:var(--cf-text);line-height:1.6;-webkit-font-smoothing:antialiased}
header{background:var(--cf-bg);height:60px;padding:0 32px;display:flex;align-items:center;
  justify-content:space-between;position:relative}
header::after{content:"";position:absolute;bottom:0;left:0;right:0;height:1px;
  background-image:linear-gradient(to right,var(--cf-border) 50%,transparent 50%);
  background-size:12px 1px;background-repeat:repeat-x}
.logo{display:flex;align-items:center;gap:10px;text-decoration:none;color:var(--cf-text)}
.logo svg{height:26px;color:var(--cf-orange)}
.logo-text{font-size:16px;font-weight:500;letter-spacing:-.02em}
.logo-text span{color:var(--cf-text-muted);font-weight:400}
.main{max-width:1100px;margin:0 auto;padding:40px 32px}
.page-eyebrow{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.07em;
  color:var(--cf-text-muted);margin-bottom:8px}
h1{font-size:28px;font-weight:500;letter-spacing:-.02em;margin-bottom:6px}
.subtitle{font-size:14px;color:var(--cf-text-muted);margin-bottom:40px}
.dashed{height:1px;background-image:linear-gradient(to right,var(--cf-border) 50%,transparent 50%);
  background-size:12px 1px;background-repeat:repeat-x;margin:32px 0}
.card{position:relative;background:var(--cf-bg-card);border:1px solid var(--cf-border)}
.card .cb{position:absolute;width:8px;height:8px;border:1px solid var(--cf-border);
  border-radius:1.5px;background:var(--cf-bg);z-index:2}
.card .cb.tl{top:-4px;left:-4px}.card .cb.tr{top:-4px;right:-4px}
.card .cb.bl{bottom:-4px;left:-4px}.card .cb.br{bottom:-4px;right:-4px}
.card-hdr{padding:14px 18px;border-bottom:1px solid rgba(235,213,193,.4);
  display:flex;align-items:center;justify-content:space-between}
.card-hdr-label{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;
  color:var(--cf-text-muted)}
.card-body{padding:20px 18px}
table{width:100%;border-collapse:collapse;font-size:13px}
th{padding:8px 12px;text-align:left;font-size:10px;font-weight:600;letter-spacing:.05em;
  text-transform:uppercase;color:var(--cf-text-muted);border-bottom:1px solid var(--cf-border);
  white-space:nowrap}
td{padding:10px 12px;border-bottom:1px solid rgba(235,213,193,.3);vertical-align:middle;
  color:var(--cf-text-muted)}
td strong{color:var(--cf-text);font-weight:500}
tr:last-child td{border-bottom:none}
tr:hover td{background:var(--cf-bg-hover)}
.badge{display:inline-block;padding:2px 8px;border-radius:9999px;font-size:10px;font-weight:600}
.badge-o{background:rgba(255,72,1,.08);color:var(--cf-orange)}
.badge-g{background:rgba(22,163,74,.1);color:var(--cf-success)}
.badge-m{background:rgba(235,213,193,.4);color:var(--cf-text-muted)}
button,.btn{display:inline-flex;align-items:center;gap:6px;padding:7px 14px;
  border-radius:9999px;font-size:12px;font-weight:500;border:1px solid var(--cf-border);
  background:var(--cf-bg-card);color:var(--cf-text-muted);cursor:pointer;
  transition:all .15s ease;font-family:inherit}
button:hover,.btn:hover{background:var(--cf-bg-hover);color:var(--cf-text);border-style:dashed}
button.danger{color:var(--cf-error);border-color:rgba(220,38,38,.3)}
button.danger:hover{background:rgba(220,38,38,.05)}
button.primary{background:var(--cf-orange);color:#fff;border-color:transparent}
button.primary:hover{opacity:.9;border-style:solid}
input,select{border:1px solid var(--cf-border);background:var(--cf-bg-card);color:var(--cf-text);
  font-family:inherit;font-size:13px;border-radius:6px;padding:8px 12px;width:100%;
  outline:none;transition:border-color .15s}
input:focus,select:focus{border-color:var(--cf-orange);box-shadow:0 0 0 3px rgba(255,72,1,.1)}
label{display:block;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;
  color:var(--cf-text-muted);margin-bottom:5px}
.form-grid{display:grid;grid-template-columns:1fr 1fr 1fr auto;gap:12px;align-items:end}
.files-panel{background:var(--cf-bg);border-top:1px solid rgba(235,213,193,.4);padding:12px 18px}
.file-row{display:flex;align-items:center;justify-content:space-between;padding:6px 0;
  border-bottom:1px solid rgba(235,213,193,.2);font-size:12px}
.file-row:last-child{border-bottom:none}
.file-path{color:var(--cf-text);font-family:"SF Mono","Fira Code",monospace;font-size:11px}
.file-actions{display:flex;gap:6px}
.file-link{color:var(--cf-orange);text-decoration:none;font-size:11px;font-weight:500}
.file-link:hover{text-decoration:underline}
#auth-overlay{position:fixed;inset:0;background:var(--cf-bg);display:flex;
  align-items:center;justify-content:center;z-index:100}
.auth-box{background:var(--cf-bg-card);border:1px solid var(--cf-border);padding:32px;
  width:360px;position:relative}
.auth-box .cb{position:absolute;width:8px;height:8px;border:1px solid var(--cf-border);
  border-radius:1.5px;background:var(--cf-bg);z-index:2}
.auth-box .cb.tl{top:-4px;left:-4px}.auth-box .cb.tr{top:-4px;right:-4px}
.auth-box .cb.bl{bottom:-4px;left:-4px}.auth-box .cb.br{bottom:-4px;right:-4px}
.toast{position:fixed;bottom:24px;right:24px;background:var(--cf-text);color:var(--cf-bg);
  padding:10px 18px;border-radius:9999px;font-size:13px;font-weight:500;
  opacity:0;transition:opacity .2s;pointer-events:none;z-index:200}
.toast.show{opacity:1}
.empty{padding:32px;text-align:center;color:var(--cf-text-subtle);font-size:13px}
</style>
</head>
<body>

<!-- Auth overlay -->
<div id="auth-overlay">
  <div class="auth-box">
    <div class="cb tl"></div><div class="cb tr"></div>
    <div class="cb bl"></div><div class="cb br"></div>
    <div style="margin-bottom:24px">
      <div class="page-eyebrow">AI Sandbox Worker</div>
      <div style="font-size:20px;font-weight:500;letter-spacing:-.02em">Admin Dashboard</div>
    </div>
    <label for="admin-key">Admin Secret</label>
    <input type="password" id="admin-key" placeholder="Enter ADMIN_SECRET" style="margin-bottom:16px">
    <button class="primary" style="width:100%" onclick="authenticate()">Unlock</button>
    <div id="auth-error" style="color:var(--cf-error);font-size:12px;margin-top:10px;display:none">
      Incorrect secret — check your ADMIN_SECRET
    </div>
  </div>
</div>

<header>
  <a class="logo" href="#">
    <svg viewBox="0 0 66 30" fill="currentColor"><path d="M52.688 13.028c-.22 0-.437.008-.654.015a.3.3 0 0 0-.102.024.37.37 0 0 0-.236.255l-.93 3.249c-.401 1.397-.252 2.687.422 3.634.618.876 1.646 1.39 2.894 1.45l5.045.306a.45.45 0 0 1 .435.41.5.5 0 0 1-.025.223.64.64 0 0 1-.547.426l-5.242.306c-2.848.132-5.912 2.456-6.987 5.29l-.378 1a.28.28 0 0 0 .248.382h18.054a.48.48 0 0 0 .464-.35c.32-1.153.482-2.344.48-3.54 0-7.22-5.79-13.072-12.933-13.072M44.807 29.578l.334-1.175c.402-1.397.253-2.687-.42-3.634-.62-.876-1.647-1.39-2.896-1.45l-23.665-.306a.47.47 0 0 1-.374-.199.5.5 0 0 1-.052-.434.64.64 0 0 1 .552-.426l23.886-.306c2.836-.131 5.9-2.456 6.975-5.29l1.362-3.6a.9.9 0 0 0 .04-.477C48.997 5.259 42.789 0 35.367 0c-6.842 0-12.647 4.462-14.73 10.665a6.92 6.92 0 0 0-4.911-1.374c-3.28.33-5.92 3.002-6.246 6.318a7.2 7.2 0 0 0 .18 2.472C4.3 18.241 0 22.679 0 28.133q0 .74.106 1.453a.46.46 0 0 0 .457.402h43.704a.57.57 0 0 0 .54-.418"/></svg>
    <span class="logo-text">Cloudflare <span>Sandbox Admin</span></span>
  </a>
  <button onclick="loadUsers()" style="font-size:12px">↻ Refresh</button>
</header>

<div class="main">
  <div class="page-eyebrow">AI Sandbox Worker</div>
  <h1>User Management</h1>
  <p class="subtitle">Manage user sandboxes, service tokens, and workspace files.</p>

  <!-- Add user -->
  <div class="card" style="margin-bottom:32px">
    <div class="cb tl"></div><div class="cb tr"></div>
    <div class="cb bl"></div><div class="cb br"></div>
    <div class="card-hdr">
      <span class="card-hdr-label">Register New User</span>
    </div>
    <div class="card-body">
      <div class="form-grid">
        <div><label>Display Name</label><input id="new-name" placeholder="Tim Seiffert"></div>
        <div><label>Email (@cloudflare.com)</label><input id="new-email" placeholder="tim@cloudflare.com"></div>
        <div><label>CF-Access-Client-Id</label><input id="new-clientid" placeholder="abc123.access"></div>
        <button class="primary" onclick="addUser()">Add User</button>
      </div>
    </div>
  </div>

  <!-- User list -->
  <div class="card" id="users-card">
    <div class="cb tl"></div><div class="cb tr"></div>
    <div class="cb bl"></div><div class="cb br"></div>
    <div class="card-hdr">
      <span class="card-hdr-label">Registered Users</span>
      <span id="user-count" class="badge badge-m">—</span>
    </div>
    <div id="users-body">
      <div class="empty">Loading…</div>
    </div>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
let ADMIN_KEY = '';
const BASE = window.location.origin;

function toast(msg, ok = true) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.style.background = ok ? 'var(--cf-text)' : 'var(--cf-error)';
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2500);
}

async function api(path, opts = {}) {
  const res = await fetch(BASE + '/admin/api' + path, {
    ...opts,
    headers: { 'X-Admin-Key': ADMIN_KEY, 'Content-Type': 'application/json', ...(opts.headers ?? {}) },
  });
  if (!res.ok && res.status === 401) { showAuth(); return null; }
  return res;
}

async function authenticate() {
  const key = document.getElementById('admin-key').value.trim();
  if (!key) return;
  ADMIN_KEY = key;
  const res = await api('/users');
  if (!res) { document.getElementById('auth-error').style.display = 'block'; ADMIN_KEY = ''; return; }
  sessionStorage.setItem('adminKey', key);
  document.getElementById('auth-overlay').style.display = 'none';
  renderUsers(await res.json());
}

function showAuth() {
  sessionStorage.removeItem('adminKey');
  document.getElementById('auth-overlay').style.display = 'flex';
}

async function loadUsers() {
  const res = await api('/users');
  if (!res) return;
  renderUsers(await res.json());
}

function renderUsers(users) {
  document.getElementById('user-count').textContent = users.length + ' users';
  if (!users.length) {
    document.getElementById('users-body').innerHTML = '<div class="empty">No users registered yet.</div>';
    return;
  }
  const rows = users.map(u => \`
    <tr id="row-\${btoa(u.email).replace(/=/g,'')}">
      <td><strong>\${u.name}</strong></td>
      <td>\${u.email}</td>
      <td><code style="font-size:10px;color:var(--cf-text-muted)">\${u.clientId}</code></td>
      <td>\${new Date(u.createdAt).toLocaleDateString()}</td>
      <td><span class="badge \${u.fileCount > 0 ? 'badge-g' : 'badge-m'}">\${u.fileCount} files</span></td>
      <td style="white-space:nowrap;display:flex;gap:6px;padding:8px 12px">
        <button onclick="toggleFiles('\${u.email}')">Files</button>
        <button onclick="rotateToken('\${u.email}')">Rotate token</button>
        <button class="danger" onclick="wipeWorkspace('\${u.email}')">Wipe workspace</button>
        <button class="danger" onclick="removeUser('\${u.email}')">Remove</button>
      </td>
    </tr>
    <tr id="files-\${btoa(u.email).replace(/=/g,'')}" style="display:none">
      <td colspan="6" style="padding:0">
        <div class="files-panel" id="fp-\${btoa(u.email).replace(/=/g,'')}">Loading files…</div>
      </td>
    </tr>
  \`).join('');
  document.getElementById('users-body').innerHTML = \`
    <table>
      <thead><tr><th>Name</th><th>Email</th><th>Client-Id</th><th>Registered</th><th>Workspace</th><th>Actions</th></tr></thead>
      <tbody>\${rows}</tbody>
    </table>
  \`;
}

async function addUser() {
  const name = document.getElementById('new-name').value.trim();
  const email = document.getElementById('new-email').value.trim();
  const clientId = document.getElementById('new-clientid').value.trim();
  if (!email || !clientId) { toast('Email and Client-Id are required', false); return; }
  const res = await api('/users', { method: 'POST', body: JSON.stringify({ name: name || email, email, clientId }) });
  if (!res) return;
  if (res.ok) { toast('User registered'); document.getElementById('new-name').value = ''; document.getElementById('new-email').value = ''; document.getElementById('new-clientid').value = ''; loadUsers(); }
  else toast('Error: ' + (await res.json()).error, false);
}

async function removeUser(email) {
  if (!confirm('Remove ' + email + ' from the registry?\\nTheir workspace files are NOT deleted.')) return;
  const res = await api('/users/' + encodeURIComponent(email), { method: 'DELETE' });
  if (res?.ok) { toast('User removed'); loadUsers(); }
  else toast('Error removing user', false);
}

async function wipeWorkspace(email) {
  if (!confirm('Wipe ALL workspace files for ' + email + '?\\nThis cannot be undone.')) return;
  const res = await api('/users/' + encodeURIComponent(email) + '/workspace', { method: 'DELETE' });
  if (res?.ok) { toast('Workspace wiped'); loadUsers(); }
  else toast('Error wiping workspace', false);
}

async function rotateToken(email) {
  const newClientId = prompt('New CF-Access-Client-Id for ' + email + ':');
  if (!newClientId) return;
  const res = await api('/users/' + encodeURIComponent(email), { method: 'PUT', body: JSON.stringify({ clientId: newClientId }) });
  if (res?.ok) { toast('Token updated — workspace unchanged'); loadUsers(); }
  else toast('Error updating token', false);
}

async function toggleFiles(email) {
  const key = btoa(email).replace(/=/g, '');
  const row = document.getElementById('files-' + key);
  const panel = document.getElementById('fp-' + key);
  if (row.style.display === 'none') {
    row.style.display = '';
    const res = await api('/users/' + encodeURIComponent(email) + '/files');
    if (!res) return;
    const files = await res.json();
    if (!files.length) { panel.innerHTML = '<div style="color:var(--cf-text-subtle);font-size:12px;padding:4px 0">No files in workspace</div>'; return; }
    panel.innerHTML = files.map(f => {
      const isHtml = f.path.endsWith('.html');
      const viewUrl = BASE + '/view?user=' + encodeURIComponent(email) + '&file=' + encodeURIComponent(f.path);
      return \`<div class="file-row">
        <span class="file-path">\${f.path}</span>
        <div class="file-actions">
          \${isHtml ? '<a class="file-link" href="' + viewUrl + '" target="_blank">View ↗</a>' : ''}
          <button style="padding:3px 10px;font-size:11px" class="danger" onclick="deleteFile('\${email}','\${f.path}')">Delete</button>
        </div>
      </div>\`;
    }).join('');
  } else {
    row.style.display = 'none';
  }
}

async function deleteFile(email, path) {
  if (!confirm('Delete ' + path + '?')) return;
  const res = await api('/users/' + encodeURIComponent(email) + '/files?path=' + encodeURIComponent(path), { method: 'DELETE' });
  if (res?.ok) { toast('File deleted'); toggleFiles(email); toggleFiles(email); }
  else toast('Error deleting file', false);
}

// Auto-authenticate if key is in sessionStorage
window.addEventListener('load', () => {
  const saved = sessionStorage.getItem('adminKey');
  if (saved) { document.getElementById('admin-key').value = saved; authenticate(); }
});
document.getElementById('admin-key').addEventListener('keydown', e => { if (e.key === 'Enter') authenticate(); });
</script>
</body>
</html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

// ─── Providers ────────────────────────────────────────────────────────────────

const domainProvider = { tools: domainTools } as const;

function makeGitprismProvider() {
  return {
    name: "gitprism",
    tools: {
      ingest_repo: {
        description: [
          "Convert any public GitHub repository into LLM-ready Markdown.",
          "Args: { url: string (GitHub URL or owner/repo shorthand),",
          "        detail?: 'summary' | 'structure' | 'file-list' | 'full' (default: 'full') }",
        ].join("\n"),
        execute: async (args: unknown) => {
          const { url, detail = "full" } = args as { url: string; detail?: string };
          const client = new Client({ name: "ai-sandbox", version: "1.0.0" });
          const transport = new StreamableHTTPClientTransport(
            new URL("https://gitprism.cloudemo.org/mcp")
          );
          await client.connect(transport);
          try {
            const result = await client.callTool({ name: "ingest_repo", arguments: { url, detail } });
            const content = (result.content as Array<{ type: string; text?: string }>)[0];
            return content?.type === "text" ? content.text : JSON.stringify(content);
          } finally {
            await client.close();
          }
        },
      },
    },
  };
}

const CONTENT_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  json: "application/json; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  csv: "text/csv; charset=utf-8",
};

// ─── SandboxAgent DO ──────────────────────────────────────────────────────────

export class SandboxAgent extends McpAgent<Env, Record<string, never>, {}> {
  server = new McpServer({ name: "ai-sandbox", version: "1.0.0" });

  workspace = new Workspace({
    sql: this.ctx.storage.sql,
    r2: this.env.STORAGE,
    name: () => this.name,
  });

  // ── Internal admin routes (called by Worker-level admin handlers) ─────────
  // These are NOT exposed publicly — only reachable via Worker-to-DO fetch
  // on paths starting with /__admin/, which the public fetch handler never
  // forwards.

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Serve a workspace file — public, no auth
    if (url.pathname === "/view") {
      const file = url.searchParams.get("file") ?? "/reports/dashboard.html";
      const content = await this.workspace.readFile(file);
      if (content === null) return new Response(`File not found: ${file}`, { status: 404 });
      const ext = file.split(".").pop()?.toLowerCase() ?? "txt";
      return new Response(content, {
        headers: { "Content-Type": CONTENT_TYPES[ext] ?? "text/plain; charset=utf-8" },
      });
    }

    // Admin: list workspace files
    if (url.pathname === "/__admin/files" && request.method === "GET") {
      try {
        const files = await this.workspace.glob("/**/*");
        const withSizes = await Promise.all(
          files.map(async (path) => {
            const stat = await this.workspace.stat(path);
            return { path, size: stat?.size ?? 0 };
          })
        );
        return new Response(JSON.stringify(withSizes), {
          headers: { "Content-Type": "application/json" },
        });
      } catch {
        return new Response("[]", { headers: { "Content-Type": "application/json" } });
      }
    }

    // Admin: delete a specific file
    if (url.pathname === "/__admin/files" && request.method === "DELETE") {
      const path = url.searchParams.get("path");
      if (!path) return new Response("Missing ?path=", { status: 400 });
      await this.workspace.rm(path);
      return new Response(JSON.stringify({ deleted: path }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Admin: wipe entire workspace
    if (url.pathname === "/__admin/workspace" && request.method === "DELETE") {
      try {
        const files = await this.workspace.glob("/**/*");
        await Promise.all(files.map((f) => this.workspace.rm(f)));
      } catch { /* already empty */ }
      return new Response(JSON.stringify({ wiped: true }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response("Not found", { status: 404 });
  }

  async init() {
    // ── run_code ──────────────────────────────────────────────────────────────
    this.server.tool(
      "run_code",
      [
        "Execute JavaScript code in an isolated V8 sandbox (~2ms startup, no network).",
        "",
        "Available in sandbox:",
        "  state.*     — filesystem ops: readFile, writeFile, glob, searchFiles,",
        "                replaceInFiles, diff, readJson, writeJson, walkTree, ...",
        "  codemode.*  — domain tools: " + Object.keys(domainTools).join(", "),
        "  gitprism.*  — ingest_repo({ url, detail? })",
        "                Converts a public GitHub repo to Markdown.",
        "                detail: 'summary' | 'structure' | 'file-list' | 'full'",
        "",
        "Files written via state.* persist across all sessions for this user.",
        "The code must be an async arrow function or a block of statements.",
      ].join("\n"),
      { code: z.string().describe("JavaScript to run. Can use state.*, codemode.*, and gitprism.*") },
      async ({ code }) => {
        const executor = new DynamicWorkerExecutor({ loader: this.env.LOADER, globalOutbound: null });
        const { result, logs, error } = await executor.execute(code, [
          resolveProvider(stateTools(this.workspace)),
          resolveProvider(domainProvider),
          resolveProvider(makeGitprismProvider()),
        ]);
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ result, logs: logs ?? [], error: error ?? null }, null, 2) }],
        };
      }
    );

    // ── run_bundled_code ──────────────────────────────────────────────────────
    this.server.tool(
      "run_bundled_code",
      [
        "Like run_code, but installs npm packages at runtime so the sandbox can import them.",
        "Prefer run_code for tasks that don't need external packages — it's much faster.",
        "Use dynamic import(): const { chunk } = await import('lodash');",
        "state.*, codemode.*, and gitprism.* are available exactly as in run_code.",
      ].join("\n"),
      {
        code: z.string().describe("JavaScript to run. Use dynamic import() to load declared packages."),
        packages: z.record(z.string()).optional().describe("npm packages: { name: versionRange }"),
      },
      async ({ code, packages }) => {
        const { modules: bundledModules } = await createWorker({
          files: {
            "src/entry.ts": Object.keys(packages ?? {}).map((p) => `import "${p}";`).join("\n") || "export {}",
            ...(packages ? { "package.json": JSON.stringify({ dependencies: packages }) } : {}),
          },
        });
        const executor = new DynamicWorkerExecutor({
          loader: this.env.LOADER,
          globalOutbound: null,
          modules: bundledModules as Record<string, string>,
        });
        const { result, logs, error } = await executor.execute(code, [
          resolveProvider(stateTools(this.workspace)),
          resolveProvider(domainProvider),
          resolveProvider(makeGitprismProvider()),
        ]);
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ result, logs: logs ?? [], error: error ?? null }, null, 2) }],
        };
      }
    );

    // ── get_report_url ────────────────────────────────────────────────────────
    // DO name is "user:email" — strip prefix to build the stable report URL
    this.server.tool(
      "get_report_url",
      [
        "Get a shareable browser URL for a file written to the workspace.",
        "Use this after generating an HTML report with run_code.",
        "The URL is stable — it is tied to your user identity, not the current session.",
      ].join("\n"),
      {
        file: z.string().default("/reports/dashboard.html").describe("Workspace path, e.g. /reports/dashboard.html"),
      },
      async ({ file }) => {
        const base = this.env.PUBLIC_URL.replace(/\/$/, "");
        // this.name is "user:email" — use the email as the stable ?user= param
        const userEmail = this.name.replace(/^user:/, "");
        const url = `${base}/view?user=${encodeURIComponent(userEmail)}&file=${encodeURIComponent(file)}`;
        return { content: [{ type: "text" as const, text: url }] };
      }
    );
  }
}

// ─── Worker fetch handler ─────────────────────────────────────────────────────
//
// Routing:
//   /mcp         → Cloudflare Access auth → KV lookup → user's stable DO
//   /view        → public, ?user=email → serve file from that user's workspace
//   /admin       → CF-design HTML dashboard (requires X-Admin-Key)
//   /admin/api/* → JSON REST API (requires X-Admin-Key)
//
// Cloudflare Access setup (dashboard):
//   1. Zero Trust → Settings → Authentication → Add Google IdP
//   2. Access → Applications → Add Self-Hosted:
//      Domain: ai-sandbox.cloudemo.org  Path: /mcp
//      Policy: Emails ending in @cloudflare.com
//   3. Service Auth → Service Tokens → Create one per user
//      Send Client-Id + Client-Secret to each user for their opencode.jsonc
//   4. Register each user via POST /admin/api/users or the admin dashboard
//
// Each user's opencode.jsonc:
//   "mcp": {
//     "ai-sandbox": {
//       "type": "remote",
//       "url": "https://ai-sandbox.cloudemo.org/mcp",
//       "headers": {
//         "CF-Access-Client-Id": "their-client-id.access",
//         "CF-Access-Client-Secret": "their-client-secret"
//       }
//     }
//   }

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // ── Admin dashboard ─────────────────────────────────────────────────────
    if (url.pathname === "/admin") {
      if (!isAdminAuthorized(request, env)) {
        // Return the dashboard HTML — auth is handled client-side via the
        // unlock screen so the page itself is always served (it shows nothing
        // until a correct key is entered)
        return adminDashboard();
      }
      return adminDashboard();
    }

    // ── Admin API ───────────────────────────────────────────────────────────
    if (url.pathname.startsWith("/admin/api")) {
      return handleAdminApi(request, env);
    }

    // ── MCP endpoint ────────────────────────────────────────────────────────
    if (url.pathname.startsWith("/mcp")) {
      const email = await resolveUserEmail(request, env);
      if (!email) {
        return new Response(
          "Unauthorized — valid Cloudflare Access credentials required.\n" +
          "Add CF-Access-Client-Id and CF-Access-Client-Secret headers to your MCP config.",
          { status: 401 }
        );
      }
      // Route every request from this user to their permanent DO instance
      const id = env.SandboxAgent.idFromName(doNameForEmail(email));
      return env.SandboxAgent.get(id).fetch(request);
    }

    // ── View endpoint (public) ──────────────────────────────────────────────
    if (url.pathname === "/view") {
      const userEmail = url.searchParams.get("user");
      if (!userEmail) {
        return new Response("Missing required query param: ?user=EMAIL", { status: 400 });
      }
      const id = env.SandboxAgent.idFromName(doNameForEmail(userEmail));
      return env.SandboxAgent.get(id).fetch(request);
    }

    return new Response("Not found", { status: 404 });
  },
};
