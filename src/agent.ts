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

// ─── Env ─────────────────────────────────────────────────────────────────────

export interface Env {
  LOADER: WorkerLoader;
  SandboxAgent: DurableObjectNamespace;
  STORAGE?: R2Bucket;
  // Set in wrangler.jsonc — used to build shareable /view URLs
  PUBLIC_URL: string;
}

// ─── Domain tool provider ────────────────────────────────────────────────────

const domainProvider = {
  tools: domainTools,
} as const;

// ─── GitPrism provider ───────────────────────────────────────────────────────

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
            const result = await client.callTool({
              name: "ingest_repo",
              arguments: { url, detail },
            });
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

// ─── Content-type helper ─────────────────────────────────────────────────────

const CONTENT_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  json: "application/json; charset=utf-8",
  md:   "text/markdown; charset=utf-8",
  txt:  "text/plain; charset=utf-8",
  csv:  "text/csv; charset=utf-8",
};

// ─── SandboxAgent ─────────────────────────────────────────────────────────────

export class SandboxAgent extends McpAgent<Env, Record<string, never>, {}> {
  server = new McpServer({ name: "ai-sandbox", version: "1.0.0" });

  workspace = new Workspace({
    sql: this.ctx.storage.sql,
    r2: this.env.STORAGE,
    name: () => this.name,
  });

  // ── /view handler ──────────────────────────────────────────────────────────
  // Called by the Worker-level fetch when the request is routed to this DO.
  // Serves any file from the session's workspace by path.
  //
  // URL: https://WORKER/view?session=SESSION_NAME&file=/reports/dashboard.html
  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/view") {
      const file = url.searchParams.get("file") ?? "/reports/dashboard.html";
      const content = await this.workspace.readFile(file);

      if (content === null) {
        return new Response(`File not found: ${file}`, { status: 404 });
      }

      const ext = file.split(".").pop()?.toLowerCase() ?? "txt";
      const contentType = CONTENT_TYPES[ext] ?? "text/plain; charset=utf-8";
      return new Response(content, { headers: { "Content-Type": contentType } });
    }

    return new Response("Not found", { status: 404 });
  }

  async init() {
    // ── Tool: run_code ────────────────────────────────────────────────────────

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
        "Files written via state.* persist across multiple run_code calls in the",
        "same session. Use them to accumulate context or checkpoint work.",
        "",
        "The code must be an async arrow function or a block of statements.",
        "Its return value is JSON-serialized and returned as the tool result.",
      ].join("\n"),
      { code: z.string().describe("JavaScript to run. Can use state.*, codemode.*, and gitprism.*") },
      async ({ code }) => {
        const executor = new DynamicWorkerExecutor({
          loader: this.env.LOADER,
          globalOutbound: null,
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

    // ── Tool: run_bundled_code ────────────────────────────────────────────────

    this.server.tool(
      "run_bundled_code",
      [
        "Like run_code, but installs npm packages at runtime so the sandbox can import them.",
        "Prefer run_code for tasks that don't need external packages — it's much faster.",
        "",
        "The bundled modules are injected into the sandbox. Use dynamic import():",
        "  const { chunk } = await import('lodash');",
        "",
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

    // ── Tool: get_report_url ──────────────────────────────────────────────────
    // Returns a shareable URL for any file in the session's workspace.
    // Use this after generating an HTML report to get a link you can open
    // in a browser or share with stakeholders.

    this.server.tool(
      "get_report_url",
      [
        "Get a shareable browser URL for a file written to the workspace.",
        "Use this after generating an HTML report with run_code.",
        "The URL can be opened directly in any browser — no login required.",
        "",
        "Example: after writing /reports/dashboard.html, call this tool to get",
        "a link you can share with stakeholders.",
      ].join("\n"),
      {
        file: z.string().default("/reports/dashboard.html").describe("Workspace path to serve, e.g. /reports/dashboard.html"),
      },
      async ({ file }) => {
        const base = this.env.PUBLIC_URL.replace(/\/$/, "");
        const url = `${base}/view?session=${encodeURIComponent(this.name)}&file=${encodeURIComponent(file)}`;
        return {
          content: [{ type: "text" as const, text: url }],
        };
      }
    );
  }
}

// ─── Worker entry point ───────────────────────────────────────────────────────
// Wraps McpAgent.serve() to also handle /view requests.
//
// /mcp  → MCP protocol (OpenCode connects here)
// /view → serves workspace files; route: ?session=NAME&file=/path/to/file.html
//
// Add to opencode.jsonc:
//   "mcp": { "my-sandbox": { "type": "remote", "url": "https://WORKER.workers.dev/mcp" } }

const mcpHandler = SandboxAgent.serve("/mcp", { binding: "SandboxAgent" });

export default {
  ...(mcpHandler as object),

  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Route /view to the correct DO instance (identified by ?session=)
    if (url.pathname === "/view") {
      const session = url.searchParams.get("session");
      if (!session) {
        return new Response("Missing required query param: ?session=SESSION_NAME", { status: 400 });
      }
      const id = env.SandboxAgent.idFromName(session);
      const stub = env.SandboxAgent.get(id);
      return stub.fetch(request);
    }

    // Everything else goes to the MCP handler
    return (mcpHandler as any).fetch(request, env, ctx);
  },
};
