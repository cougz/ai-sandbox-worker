/**
 * ChatSession Durable Object
 *
 * One instance per user (keyed by email hash).  Manages the OpenCode server
 * lifecycle inside the Cloudflare Container and persists per-user configuration.
 *
 * Follows the OpenCodeWrapper pattern from let-it-slide
 * (cloudflare/ai-agents/let-it-slide — app/src/server/opencode.ts).
 */

import { DurableObject } from "cloudflare:workers";
import { getSandbox } from "@cloudflare/sandbox";
// These subpath exports resolve after `npm install` (version 0.8.9).
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — resolved at runtime; types available after npm install
import { createOpencode } from "@cloudflare/sandbox/opencode";
import type { Env } from "./agent";

// ─── Constants ────────────────────────────────────────────────────────────────

const OPENCODE_PORT           = 4096;
const WORKSPACE_DIR           = "/home/user/workspace";
const HEALTH_CHECK_TIMEOUT_MS = 5_000;
const MCP_SERVER_NAME         = "ai-sandbox";
const DEFAULT_MODEL           = "@cf/moonshotai/kimi-k2.6";

// ─── Available Workers AI models ─────────────────────────────────────────────
// Kimi K2.6 is the default (262K context, strong function calling/tool use).
// All models listed here must support tool_calls for MCP tools to work.

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
  /** Workers AI model ID, e.g. "@cf/moonshotai/kimi-k2.6" */
  model: string;
  /** User-added MCP servers beyond the default ai-sandbox one */
  mcpServers: Record<string, { url: string; enabled: boolean }>;
}

interface OpenCodeInstance {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client:       any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  server:       any;
  publicOrigin: string;
}

// ─── ChatSession DO ───────────────────────────────────────────────────────────

export class ChatSession extends DurableObject<Env> {
  private instances     = new Map<string, OpenCodeInstance>();
  private sessionIds    = new Map<string, string>();
  private publicOrigins = new Map<string, string>();

  /** Cast helper — mirrors the `(env as any).Sandbox` pattern in access-handler.ts */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private get sandboxNs(): any {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (this.env as any).Sandbox;
  }

  // ── Config builder ─────────────────────────────────────────────────────────

  private buildOptions(
    publicOrigin: string,
    sandboxId:   string,
    userConfig:  ChatUserConfig,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): any {
    const model = userConfig.model || DEFAULT_MODEL;

    const mcpServers: Record<string, unknown> = {
      [MCP_SERVER_NAME]: {
        type:    "remote",
        url:     `${this.env.PUBLIC_URL}/mcp`,
        enabled: true,
        oauth: {
          // Proxied by the Worker at /chat/oauth/{sandboxId}/mcp/oauth/callback
          redirectUri: `${publicOrigin}/chat/oauth/${sandboxId}/mcp/oauth/callback`,
        },
      },
    };

    // Merge user-added MCP servers (cannot override ai-sandbox)
    for (const [name, cfg] of Object.entries(userConfig.mcpServers || {})) {
      if (name !== MCP_SERVER_NAME) {
        mcpServers[name] = { type: "remote", url: cfg.url, enabled: cfg.enabled };
      }
    }

    return {
      port:      OPENCODE_PORT,
      directory: WORKSPACE_DIR,
      config: {
        // Route through /chat/ai/v1 on this Worker (env.AI binding, no API token)
        model:              `openai-compatible/${model}`,
        share:              "disabled",
        enabled_providers:  ["openai-compatible"],
        provider: {
          "openai-compatible": {
            options: {
              baseURL: `${publicOrigin}/chat/ai/v1`,
              // Workers AI proxy validates CF Access auth, not a Bearer token.
              // OpenCode requires a non-empty string; the proxy ignores this value.
              apiKey: "workers-ai",
            },
            models: Object.fromEntries(
              Object.entries(AVAILABLE_MODELS).map(([id, name]) => [id, { name }])
            ),
          },
        },
        mcp: mcpServers,
        permission: {
          bash:               "allow",
          edit:               "allow",
          write:              "allow",
          webfetch:           "allow",
          external_directory: "deny",
        },
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

  /** Start (or verify) the OpenCode server inside the container. Idempotent. */
  async ensureServer(sandboxId: string, publicOrigin: string): Promise<void> {
    const nextOrigin = publicOrigin || this.publicOrigins.get(sandboxId);
    if (!nextOrigin) throw new Error(`No public origin configured for sandbox ${sandboxId}`);

    const existing = this.instances.get(sandboxId);
    if (existing) {
      if (existing.publicOrigin !== nextOrigin) {
        console.log(`[ChatSession] Origin changed for ${sandboxId}, recreating`);
        this.publicOrigins.set(sandboxId, nextOrigin);
        this.resetInstance(sandboxId);
      } else {
        const sandbox = getSandbox(this.sandboxNs, sandboxId);
        const alive   = await this.isServerAlive(sandbox, sandboxId);
        if (alive) return;
        console.log(`[ChatSession] Stale instance for ${sandboxId}, recreating`);
        this.resetInstance(sandboxId);
      }
    }

    this.publicOrigins.set(sandboxId, nextOrigin);
    const userConfig = await this.getUserConfig();
    const options    = this.buildOptions(nextOrigin, sandboxId, userConfig);
    const sandbox    = getSandbox(this.sandboxNs, sandboxId);

    const { client, server } = await createOpencode(sandbox, options);
    this.instances.set(sandboxId, { client, server, publicOrigin: nextOrigin });
    console.log(`[ChatSession] OpenCode started for sandbox ${sandboxId}`);
  }

  /** Returns true if the OpenCode process in the container is responding. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async isServerAlive(sandbox: any, sandboxId: string): Promise<boolean> {
    const existing = this.instances.get(sandboxId);
    if (!existing) return false;
    try {
      const req = new Request(`${existing.server.url}/`, {
        method: "GET",
        signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
      });
      await sandbox.containerFetch(req, OPENCODE_PORT);
      return true;
    } catch {
      return false;
    }
  }

  resetInstance(sandboxId: string): void {
    this.instances.delete(sandboxId);
    this.sessionIds.delete(sandboxId);
  }

  hasInstance(sandboxId: string): boolean {
    return this.instances.has(sandboxId);
  }

  // ── MCP management ──────────────────────────────────────────────────────────

  async getMcpStatuses(sandboxId: string): Promise<Record<string, unknown>> {
    const instance = this.instances.get(sandboxId);
    if (!instance) throw new Error("OpenCode server not started");
    const sandbox = getSandbox(this.sandboxNs, sandboxId);
    const req     = new Request(`${instance.server.url}/mcp`, { method: "GET" });
    const resp: Response = await sandbox.containerFetch(req, instance.server.port);
    if (!resp.ok) throw new Error(`OpenCode MCP status error: ${resp.status}`);
    return resp.json<Record<string, unknown>>();
  }

  async authenticateMcp(sandboxId: string, name: string): Promise<unknown> {
    const instance = this.instances.get(sandboxId);
    if (!instance) throw new Error("OpenCode server not started");
    const sandbox = getSandbox(this.sandboxNs, sandboxId);
    const req = new Request(
      `${instance.server.url}/mcp/${encodeURIComponent(name)}/auth/authenticate`,
      { method: "POST" },
    );
    const resp: Response = await sandbox.containerFetch(req, instance.server.port);
    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`MCP auth error for '${name}': ${body}`);
    }
    return resp.json();
  }
}
