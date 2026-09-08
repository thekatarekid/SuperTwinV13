import type { ProviderRequest } from "../types.js";

/** Structural, secret-free diagnostic used only by development contract tests. */
export function devRedactedRequestSnapshot(request: ProviderRequest): Record<string, unknown> {
  if (process.env.NODE_ENV === "production") {
    throw new Error("request snapshots are disabled in production");
  }
  return {
    model: request.model,
    instructions: request.instructions === "" ? "" : `<redacted:${Buffer.byteLength(request.instructions, "utf8")}b>`,
    input: request.input.map((item) => item.type === "function_call_output"
      ? { type: item.type, call_id: item.call_id, output: `<redacted:${Buffer.byteLength(item.output, "utf8")}b>` }
      : {
          type: item.type,
          role: item.role,
          content: item.content.map((content) => content.type === "input_text"
            ? { type: content.type, bytes: Buffer.byteLength(content.text, "utf8") }
            : { type: content.type, url: "<redacted>", detail: content.detail ?? null }),
        }),
    tools: request.tools?.map((tool) => ({ type: tool.type, name: tool.name })) ?? null,
    tool_choice: request.toolChoice ?? null,
    parallel_tool_calls: request.parallelToolCalls ?? null,
    continuation: request.continuation ? "<present>" : null,
    cache: request.cache ? { mode: request.cache.mode, key: request.cache.key ? "<redacted>" : null, ttl: request.cache.ttl ?? null } : null,
    max_output_tokens: request.maxOutputTokens,
    max_agent_turns: request.maxAgentTurns,
  };
}
