import { beforeEach, describe, expect, mock, test } from "bun:test"
import type { StreamEvent, StreamRequest } from "../../providers/types"
import type { MiniMaxProviderId } from "./api"

interface CapturedRequest {
  providerId: MiniMaxProviderId
  path: string
  key: string
  init: RequestInit
}

const requests: CapturedRequest[] = []
const responses: Response[] = []
const keyRequests: { providerId: MiniMaxProviderId; profileId: string }[] = []

mock.module("./api", () => ({
  providerName(providerId: MiniMaxProviderId): string {
    return providerId === "minimax" ? "MiniMax (minimax.io)" : "MiniMax Coding Plan (minimax.io)"
  },
  async miniMaxFetch(
    providerId: MiniMaxProviderId,
    path: string,
    key: string,
    init: RequestInit = {},
  ): Promise<Response> {
    requests.push({ providerId, path, key, init })
    const response = responses.shift()
    if (!response) throw new Error("missing mocked MiniMax response")
    return response
  },
}))

mock.module("./auth", () => ({
  async apiKey(providerId: MiniMaxProviderId, profileId: string): Promise<string> {
    keyRequests.push({ providerId, profileId })
    return "secret-key"
  },
}))

const { buildRequestBody, streamResponse } = await import("./transport")

function request(overrides: Partial<StreamRequest> = {}): StreamRequest {
  return {
    model: "MiniMax-M3",
    thinking: "high",
    instructions: "Answer precisely",
    input: [{ type: "user_message", text: "inspect", images: [] }],
    tools: [],
    cacheKey: "prompt-cache-key",
    toolChoice: "auto",
    sessionId: "session-456",
    ...overrides,
  }
}

function sse(frames: unknown[]): Response {
  return new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  })
}

async function collect(source: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = []
  for await (const event of source) events.push(event)
  return events
}

beforeEach(() => {
  requests.length = 0
  responses.length = 0
  keyRequests.length = 0
})

describe("MiniMax transport", () => {
  test("enables M3 thinking without M2 sampling options", () => {
    const enabled = buildRequestBody("minimax", request())
    expect(enabled.max_tokens).toBe(128_000)
    expect(enabled.thinking).toEqual({ type: "adaptive" })
    expect(enabled.temperature).toBeUndefined()
    expect(enabled.top_p).toBeUndefined()
    expect(enabled.top_k).toBeUndefined()

    const disabled = buildRequestBody("minimax", request({ thinking: "none" }))
    expect(disabled.thinking).toEqual({ type: "disabled" })
  })

  test("uses the recommended M2 sampling options without a thinking override", () => {
    const current = buildRequestBody("minimax", request({ model: "MiniMax-M2.7", thinking: undefined }))
    expect(current.max_tokens).toBe(131_072)
    expect(current.thinking).toBeUndefined()
    expect(current.temperature).toBe(1)
    expect(current.top_p).toBe(0.95)
    expect(current.top_k).toBe(40)

    const original = buildRequestBody("minimax", request({ model: "MiniMax-M2", thinking: undefined }))
    expect(original.top_k).toBe(20)
  })

  test("streams Coding Plan responses with provider-specific replay data", async () => {
    responses.push(
      sse([
        { type: "message_start", message: { usage: { input_tokens: 11, cache_read_input_tokens: 4 } } },
        { type: "content_block_start", index: 0, content_block: { type: "thinking" } },
        { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "check" } },
        { type: "content_block_stop", index: 0 },
        { type: "content_block_start", index: 1, content_block: { type: "text" } },
        { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "done" } },
        { type: "content_block_stop", index: 1 },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
        { type: "message_stop" },
      ]),
    )

    const events = await collect(streamResponse("minimax-coding-plan", "profile-1", request()))

    expect(events).toEqual([
      { type: "reasoning_summary_delta", text: "check" },
      {
        type: "item_done",
        item: {
          type: "reasoning",
          summary: "check",
          replay: {
            provider: "minimax-coding-plan",
            model: "MiniMax-M3",
            data: { type: "thinking", thinking: "check" },
          },
        },
      },
      { type: "text_delta", text: "done" },
      {
        type: "item_done",
        item: {
          type: "assistant_message",
          text: "done",
          replay: {
            provider: "minimax-coding-plan",
            model: "MiniMax-M3",
            data: { type: "text", text: "done" },
          },
        },
      },
      {
        type: "done",
        usage: { totalInputTokens: 15, cacheReadInputTokens: 4, cacheWriteInputTokens: 0, outputTokens: 3 },
      },
    ])
    expect(keyRequests).toEqual([{ providerId: "minimax-coding-plan", profileId: "profile-1" }])
    expect(requests).toHaveLength(1)
    expect(requests[0]?.providerId).toBe("minimax-coding-plan")
    expect(requests[0]?.path).toBe("/messages")
    expect(requests[0]?.key).toBe("secret-key")
    expect(requests[0]?.init.method).toBe("POST")
  })
})
