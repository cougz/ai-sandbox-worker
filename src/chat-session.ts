/**
 * ChatSession Durable Object
 *
 * One instance per user (keyed by email hash). Manages the OpenCode server
 * lifecycle inside the Cloudflare Container and persists per-user config.
 */

import { DurableObject } from "cloudflare:workers";
import { getSandbox } from "@cloudflare/sandbox";
import { createOpencodeServer, type OpencodeServer } from "@cloudflare/sandbox/opencode";
import type { Env } from "./agent";

// ─── Constants ────────────────────────────────────────────────────────────────

const OPENCODE_PORT   = 4096;
const WORKSPACE_DIR   = "/home/user/workspace";
const MCP_SERVER_NAME = "ai-sandbox";
const DEFAULT_MODEL   = "@cf/moonshotai/kimi-k2.6";

// ─── Available Workers AI models ─────────────────────────────────────────────

export const AVAILABLE_MODELS: Record<string, string> = {
  "@cf/moonshotai/kimi-k2.6":                      "Kimi K2.6 (default, 262K ctx)",
  "@cf/meta/llama-4-scout-17b-16e-instruct":        "Llama 4 Scout 17B",
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast":       "Llama 3.3 70B",
  "@cf/qwen/qwen3-235b-a22b":                       "Qwen3 235B",
  "@cf/openai/gpt-oss-120b":                        "GPT-OSS 120B",
  "@cf/deepseek-ai/deepseek-r1-distill-llama-70b":  "DeepSeek R1 Distill 70B",
};

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ChatUserConfig {
  model: string;
  mcpServers: Record<string, { url: string; enabled: boolean }>;
}

export interface ServerStatus {
  state: "idle" | "starting" | "ready" | "failed";
  log: string[];          // timestamped log lines surfaced in the loading screen
  error?: string;         // last error message if state === "failed"
  startedAt?: string;     // ISO timestamp when startup began
  readyAt?: string;       // ISO timestamp when OpenCode became ready
}

interface CachedServer {
  server:       OpencodeServer;
  publicOrigin: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function ts(): string {
  return new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
}

// ─── ChatSession DO ───────────────────────────────────────────────────────────

export class ChatSession extends DurableObject<Env> {
  private servers          = new Map<string, CachedServer>();
  private startupInProgress = new Set<string>();
  private publicOrigins    = new Map<string, string>();
  /** Per-sandbox status + log ring (last 30 lines). */
  private statuses         = new Map<string, ServerStatus>();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private get sandboxNs(): any {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (this.env as any).Sandbox;
  }

  // ── Logging helpers ─────────────────────────────────────────────────────────

  private log(sandboxId: string, msg: string): void {
    const line = `[${ts()}] ${msg}`;
    console.log(`[ChatSession:${sandboxId.slice(0, 12)}] ${msg}`);
    const s = this.getOrInitStatus(sandboxId);
    s.log.push(line);
    if (s.log.length > 30) s.log.shift();
  }

  private getOrInitStatus(sandboxId: string): ServerStatus {
    if (!this.statuses.has(sandboxId)) {
      this.statuses.set(sandboxId, { state: "idle", log: [] });
    }
    return this.statuses.get(sandboxId)!;
  }

  // ── Status (polled by the loading screen) ──────────────────────────────────

  getStatus(sandboxId: string): ServerStatus {
    const cached = this.statuses.get(sandboxId);
    if (!cached) {
      // DO was evicted and restarted — in-memory state is gone
      return {
        state: "idle",
        log: [`[${ts()}] DO state not found — may have been evicted. Will retry.`],
      };
    }
    // Sync state flags with maps in case they diverged
    if (this.servers.has(sandboxId))           cached.state = "ready";
    else if (this.startupInProgress.has(sandboxId)) cached.state = "starting";
    return cached;
  }

  // ── Config builder ──────────────────────────────────────────────────────────

  private buildOptions(publicOrigin: string, sandboxId: string, userConfig: ChatUserConfig) {
    const model = userConfig.model || DEFAULT_MODEL;

    const mcpServers: Record<string, unknown> = {
      [MCP_SERVER_NAME]: {
        type:    "remote",
        url:     `${this.env.PUBLIC_URL}/mcp`,
        enabled: true,
        oauth: {
          redirectUri: `${publicOrigin}/chat/oauth/${sandboxId}/mcp/oauth/callback`,
        },
      },
    };

    for (const [name, cfg] of Object.entries(userConfig.mcpServers || {})) {
      if (name !== MCP_SERVER_NAME) {
        mcpServers[name] = { type: "remote", url: cfg.url, enabled: cfg.enabled };
      }
    }

    return {
      port:      OPENCODE_PORT,
      directory: WORKSPACE_DIR,
      config: {
        model: `openai-compatible/${model}`,
        provider: {
          "openai-compatible": {
            options: {
              baseURL: `${publicOrigin}/chat/ai/v1`,
              apiKey:  "workers-ai",
            },
            models: Object.fromEntries(
              Object.entries(AVAILABLE_MODELS).map(([id, n]) => [id, { name: n }])
            ),
          },
        },
        mcp: mcpServers,
      },
    };
  }

  // ── User config ─────────────────────────────────────────────────────────────

  async getUserConfig(): Promise<ChatUserConfig> {
    const stored = await this.ctx.storage.get<ChatUserConfig>("config");
    return stored ?? { model: DEFAULT_MODEL, mcpServers: {} };
  }

  async updateUserConfig(patch: Partial<ChatUserConfig>): Promise<ChatUserConfig> {
    const current = await this.getUserConfig();
    const updated: ChatUserConfig = {
      model:      patch.model      ?? current.model,
      mcpServers: patch.mcpServers ?? current.mcpServers,
    };
    await this.ctx.storage.put("config", updated);
    return updated;
  }

  // ── OpenCode lifecycle ───────────────────────────────────────────────────────

  /**
   * Kick off OpenCode startup and return immediately.
   * createOpencodeServer() waits up to 180s for the container + OpenCode to
   * be ready — far beyond the Worker RPC timeout. We fire it via ctx.waitUntil
   * so the DO stays alive. The chat page polls getStatus() to know when ready.
   */
  ensureServer(sandboxId: string, publicOrigin: string): void {
    this.publicOrigins.set(sandboxId, publicOrigin);
    const status = this.getOrInitStatus(sandboxId);

    if (this.servers.has(sandboxId)) {
      this.log(sandboxId, "ensureServer called — server already ready, no-op");
      return;
    }
    if (this.startupInProgress.has(sandboxId)) {
      this.log(sandboxId, "ensureServer called — startup already in progress, no-op");
      return;
    }

    // Reset failed state to allow retry
    if (status.state === "failed") {
      this.log(sandboxId, "Previous startup failed — retrying");
      status.state = "idle";
      status.error = undefined;
    }

    this.log(sandboxId, `ensureServer called — sandbox=${sandboxId}`);
    this.log(sandboxId, `publicOrigin=${publicOrigin}`);
    this.startupInProgress.add(sandboxId);
    status.state    = "starting";
    status.startedAt = new Date().toISOString();

    const startup = this._doStart(sandboxId, publicOrigin)
      .then(() => {
        this.startupInProgress.delete(sandboxId);
        const s = this.getOrInitStatus(sandboxId);
        s.state   = "ready";
        s.readyAt = new Date().toISOString();
        this.log(sandboxId, `OpenCode ready ✓`);
      })
      .catch((err: unknown) => {
        this.startupInProgress.delete(sandboxId);
        const msg = err instanceof Error ? err.message : String(err);
        const s = this.getOrInitStatus(sandboxId);
        s.state = "failed";
        s.error = msg;
        this.log(sandboxId, `STARTUP FAILED: ${msg}`);
        console.error(`[ChatSession] startup failed for ${sandboxId}:`, msg);
      });

    this.ctx.waitUntil(startup);
  }

  private async _doStart(sandboxId: string, publicOrigin: string): Promise<void> {
    this.log(sandboxId, "Reading user config from DO storage...");
    const userConfig = await this.getUserConfig();
    this.log(sandboxId, `Config: model=${userConfig.model || DEFAULT_MODEL}`);

    const options = this.buildOptions(publicOrigin, sandboxId, userConfig);
    this.log(sandboxId, `OpenCode options built — port=${options.port}, dir=${options.directory}`);
    this.log(sandboxId, `Provider baseURL=${(options.config?.provider?.["openai-compatible"] as {options?:{baseURL?:string}})?.options?.baseURL ?? "?"}`);
    this.log(sandboxId, `MCP servers: ${Object.keys(options.config?.mcp ?? {}).join(", ")}`);

    this.log(sandboxId, "Calling getSandbox()...");
    const sandbox = getSandbox(this.sandboxNs, sandboxId);
    this.log(sandboxId, "Got sandbox stub — calling createOpencodeServer() (may take up to 180s)...");

    const server = await createOpencodeServer(sandbox, options);
    this.servers.set(sandboxId, { server, publicOrigin });
    this.log(sandboxId, `createOpencodeServer() returned — port=${server.port}`);
  }

  resetInstance(sandboxId: string): void {
    this.servers.delete(sandboxId);
    this.startupInProgress.delete(sandboxId);
    const s = this.getOrInitStatus(sandboxId);
    s.state = "idle";
    s.error = undefined;
    this.log(sandboxId, "Instance reset");
  }

  // ── MCP management ──────────────────────────────────────────────────────────

  async getMcpStatuses(sandboxId: string): Promise<Record<string, unknown>> {
    const cached = this.servers.get(sandboxId);
    if (!cached) throw new Error("OpenCode server not started");
    const sandbox = getSandbox(this.sandboxNs, sandboxId);
    const req     = new Request(`${cached.server.url}/mcp`, { method: "GET" });
    const resp: Response = await sandbox.containerFetch(req, cached.server.port);
    if (!resp.ok) throw new Error(`OpenCode MCP status error: ${resp.status}`);
    return resp.json<Record<string, unknown>>();
  }

  async authenticateMcp(sandboxId: string, name: string): Promise<unknown> {
    const cached = this.servers.get(sandboxId);
    if (!cached) throw new Error("OpenCode server not started");
    const sandbox = getSandbox(this.sandboxNs, sandboxId);
    const req = new Request(
      `${cached.server.url}/mcp/${encodeURIComponent(name)}/auth/authenticate`,
      { method: "POST" },
    );
    const resp: Response = await sandbox.containerFetch(req, cached.server.port);
    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`MCP auth error for '${name}': ${body}`);
    }
    return resp.json();
  }
}
