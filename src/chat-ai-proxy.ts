/**
 * Workers AI proxy for /chat/ai/v1/*
 *
 * OpenCode inside the container is configured to use this Worker's own
 * /chat/ai/v1 endpoint as its OpenAI-compatible provider base URL.  This
 * avoids the need for a separate Cloudflare API token — requests are
 * forwarded to the Workers AI binding (env.AI) which is already authenticated
 * as part of the Worker's own Cloudflare account.
 *
 * Supported endpoints:
 *   POST /chat/ai/v1/chat/completions  → env.AI.run(model, { messages, tools, stream })
 *   GET  /chat/ai/v1/models            → list of available Workers AI models
 */

import { AVAILABLE_MODELS } from "./chat-session";

// Workers AI binding type — populated by `wrangler types` after the `ai`
// binding is declared in wrangler.jsonc.
type AiBinding = {
  run(model: string, inputs: Record<string, unknown>): Promise<ReadableStream | Record<string, unknown>>;
};

/** Handle a /chat/ai/v1/* request. Returns null if the path doesn't match. */
export async function handleChatAiProxy(
  request: Request,
  ai: AiBinding,
): Promise<Response | null> {
  const url  = new URL(request.url);
  const path = url.pathname;

  if (!path.startsWith("/chat/ai/v1/")) return null;

  const sub = path.slice("/chat/ai/v1/".length);

  // ── GET /models ────────────────────────────────────────────────────────────
  if (request.method === "GET" && sub === "models") {
    const data = Object.entries(AVAILABLE_MODELS).map(([id, name]) => ({
      id,
      object: "model",
      created: 0,
      owned_by: "workers-ai",
      display_name: name,
    }));
    return Response.json({ object: "list", data });
  }

  // ── POST /chat/completions ─────────────────────────────────────────────────
  if (request.method === "POST" && sub === "chat/completions") {
    let body: Record<string, unknown>;
    try {
      body = await request.json<Record<string, unknown>>();
    } catch {
      return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const model = typeof body.model === "string" ? body.model : null;
    if (!model) {
      return Response.json({ error: "Missing 'model' field" }, { status: 400 });
    }

    // Validate the model is in our allowlist
    if (!AVAILABLE_MODELS[model]) {
      return Response.json(
        { error: `Model '${model}' is not available. Valid models: ${Object.keys(AVAILABLE_MODELS).join(", ")}` },
        { status: 400 },
      );
    }

    const isStream = body.stream === true;

    // Build Workers AI inputs from the OpenAI-compatible request body
    const inputs: Record<string, unknown> = {
      messages: body.messages,
      stream:   isStream,
    };

    // Pass through optional parameters if present
    if (body.tools           !== undefined) inputs.tools            = body.tools;
    if (body.tool_choice     !== undefined) inputs.tool_choice      = body.tool_choice;
    if (body.temperature     !== undefined) inputs.temperature      = body.temperature;
    if (body.max_tokens      !== undefined) inputs.max_tokens       = body.max_tokens;
    if (body.top_p           !== undefined) inputs.top_p            = body.top_p;
    if (body.frequency_penalty !== undefined) inputs.frequency_penalty = body.frequency_penalty;
    if (body.presence_penalty  !== undefined) inputs.presence_penalty  = body.presence_penalty;
    if (body.stop            !== undefined) inputs.stop             = body.stop;

    try {
      const result = await ai.run(model, inputs);

      if (isStream) {
        // Workers AI returns a ReadableStream for streaming responses.
        // The stream produces OpenAI-compatible SSE events (data: {...}\n\n).
        return new Response(result as ReadableStream, {
          headers: {
            "Content-Type":  "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection":    "keep-alive",
          },
        });
      }

      // Non-streaming: Workers AI returns the response object directly.
      // Wrap it in an OpenAI-compatible chat completion envelope.
      const aiResponse = result as Record<string, unknown>;

      // Workers AI may return { response, tool_calls } or an OpenAI-shaped object.
      // If it already looks like an OpenAI response, pass it through.
      if (aiResponse.choices) {
        return Response.json(aiResponse);
      }

      // Otherwise wrap in OpenAI envelope
      const content    = typeof aiResponse.response === "string" ? aiResponse.response : JSON.stringify(aiResponse);
      const toolCalls  = Array.isArray(aiResponse.tool_calls) ? aiResponse.tool_calls : undefined;

      return Response.json({
        id:      `chatcmpl-${crypto.randomUUID()}`,
        object:  "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          {
            index:         0,
            message: {
              role:       "assistant",
              content:    toolCalls ? null : content,
              tool_calls: toolCalls,
            },
            finish_reason: toolCalls ? "tool_calls" : "stop",
          },
        ],
        usage: {
          prompt_tokens:     aiResponse.prompt_tokens     ?? 0,
          completion_tokens: aiResponse.completion_tokens ?? 0,
          total_tokens:      aiResponse.total_tokens      ?? 0,
        },
      });

    } catch (err) {
      console.error("[chat-ai-proxy] Workers AI error", {
        model,
        error: err instanceof Error ? err.message : String(err),
      });
      return Response.json(
        { error: err instanceof Error ? err.message : "Workers AI error" },
        { status: 502 },
      );
    }
  }

  // Unknown sub-path under /chat/ai/v1/
  return Response.json({ error: `Unsupported endpoint: ${sub}` }, { status: 404 });
}
