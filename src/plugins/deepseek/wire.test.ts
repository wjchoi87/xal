import { describe, expect, test } from "bun:test"
import { ProviderError } from "../../providers/errors"
import type { ConversationItem } from "../../providers/types"
import { assistantItem, buildMessages, parseChunk, reasoningItem, requestThinking, toolCallItem } from "./wire"

describe("DeepSeek wire conversion", () => {
  test("groups assistant reasoning, text, and calls before tool results", () => {
    const items: ConversationItem[] = [
      {
        type: "user_message",
        text: "inspect",
        images: [{ mediaType: "image/jpeg", data: "YWJjZA==" }],
      },
      { type: "reasoning", summary: "thinking" },
      { type: "assistant_message", text: "working" },
      { type: "tool_call", callId: "first", name: "read", args: { path: "a.ts" } },
      { type: "tool_call", callId: "second", name: "search", args: { query: "value" } },
      { type: "tool_result", callId: "first", output: "contents" },
      { type: "assistant_message", text: "done" },
    ]

    expect(buildMessages("system prompt", items)).toEqual([
      { role: "system", content: "system prompt" },
      { role: "user", content: "inspect\n\n[1 image attachment omitted]" },
      {
        role: "assistant",
        content: "working",
        reasoning_content: "thinking",
        tool_calls: [
          { id: "first", type: "function", function: { name: "read", arguments: '{"path":"a.ts"}' } },
          { id: "second", type: "function", function: { name: "search", arguments: '{"query":"value"}' } },
        ],
      },
      { role: "tool", tool_call_id: "first", content: "contents" },
      { role: "assistant", content: "done" },
    ])
  })

  test("parses streamed content, reasoning, tool deltas, finish reason, and usage", () => {
    expect(
      parseChunk({
        choices: [
          {
            delta: {
              content: "answer",
              reasoning_content: "thought",
              tool_calls: [
                { index: 0, id: "call-id", function: { name: "read", arguments: '{"path":' } },
                { index: "invalid", function: { arguments: '"file.ts"}' } },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 10, prompt_cache_hit_tokens: 4, completion_tokens: 2 },
      }),
    ).toEqual({
      text: "answer",
      reasoning: "thought",
      toolCalls: [{ index: 0, id: "call-id", name: "read", arguments: '{"path":' }],
      finishReason: "tool_calls",
      usage: { totalInputTokens: 10, cacheReadInputTokens: 4, outputTokens: 2 },
    })
    expect(parseChunk({ choices: [], usage: { prompt_tokens: 8, completion_tokens: 1 } })).toEqual({
      toolCalls: [],
      usage: { totalInputTokens: 8, cacheReadInputTokens: undefined, outputTokens: 1 },
    })
  })

  test("surfaces provider stream errors as retryable failures", () => {
    let thrown: unknown
    try {
      parseChunk({ error: { message: "service unavailable" } })
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(ProviderError)
    if (!(thrown instanceof ProviderError)) throw new Error("expected ProviderError")
    expect(thrown.message).toBe("service unavailable")
    expect(thrown.retryable).toBe(true)
  })

  test("builds replayable output items and validates tool arguments", () => {
    expect(assistantItem("model", "answer")).toEqual({
      type: "assistant_message",
      text: "answer",
      replay: { provider: "deepseek", model: "model", data: { content: "answer" } },
    })
    expect(reasoningItem("thought")).toEqual({
      type: "reasoning",
      summary: "thought",
      replay: { provider: "deepseek", data: { reasoning_content: "thought" } },
    })
    expect(toolCallItem("model", "call-id", "read", '{"path":"file.ts"}')).toEqual({
      type: "tool_call",
      callId: "call-id",
      name: "read",
      args: { path: "file.ts" },
      replay: {
        provider: "deepseek",
        model: "model",
        data: {
          id: "call-id",
          type: "function",
          function: { name: "read", arguments: '{"path":"file.ts"}' },
        },
      },
    })
    expect(() => toolCallItem("model", "call-id", "read", "[]")).toThrow(
      "DeepSeek tool call read arguments were not an object",
    )
  })

  test("maps supported thinking modes onto the provider request", () => {
    expect(requestThinking("none")).toEqual({ thinking: { type: "disabled" } })
    expect(requestThinking("low")).toEqual({ thinking: { type: "enabled" }, reasoning_effort: "low" })
    expect(requestThinking("medium")).toEqual({ thinking: { type: "enabled" }, reasoning_effort: "high" })
    expect(requestThinking("max")).toEqual({ thinking: { type: "enabled" }, reasoning_effort: "max" })
  })
})
