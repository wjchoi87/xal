import { beforeEach, describe, expect, mock, test } from "bun:test"
import { ProviderError } from "../../providers/errors"
import type { StreamEvent, StreamRequest } from "../../providers/types"

interface CapturedRequest {
  path: string
  key: string
  init: RequestInit
}

const requests: CapturedRequest[] = []
const responses: Response[] = []
let keyRequests = 0

mock.module("./api", () => ({
  PROVIDER_ID: "deepseek",
  async deepSeekFetch(path: string, key: string, init: RequestInit = {}): Promise<Response> {
    requests.push({ path, key, init })
    const response = responses.shift()
    if (!response) throw new Error("missing mocked DeepSeek response")
    return response
  },
}))

mock.module("./auth", () => ({
  async apiKey(): Promise<string> {
    keyRequests += 1
    return "secret-key"
  },
}))

const { streamResponse } = await import("./transport")

function request(): StreamRequest {
  return {
    model: "deepseek-reasoner",
    thinking: "low",
    instructions: "Answer precisely",
    input: [{ type: "user_message", text: "inspect", images: [] }],
    tools: [
      {
        name: "read",
        description: "Read a file",
        parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      },
    ],
    cacheKey: "prompt-cache-key",
    toolChoice: "auto",
    sessionId: "session-456",
  }
}

function sse(frames: unknown[], done = false): Response {
  return new Response(
    `${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")}${done ? "data: [DONE]\n\n" : ""}`,
    { headers: { "content-type": "text/event-stream" } },
  )
}

async function collect(source: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = []
  for await (const event of source) events.push(event)
  return events
}

beforeEach(() => {
  requests.length = 0
  responses.length = 0
  keyRequests = 0
})

describe("DeepSeek transport", () => {
  test("sends the request and assembles fragmented out-of-order tool calls", async () => {
    responses.push(
      sse(
        [
          {
            choices: [
              {
                delta: {
                  content: "Hel",
                  reasoning_content: "Think ",
                  tool_calls: [
                    { index: 1, id: "call-", function: { name: "sea", arguments: '{"query":' } },
                    { index: 0, id: "call-", function: { name: "re", arguments: '{"path":' } },
                  ],
                },
                finish_reason: null,
              },
            ],
          },
          {
            choices: [
              {
                delta: {
                  content: "lo",
                  reasoning_content: "done",
                  tool_calls: [
                    { index: 0, id: "a", function: { name: "ad", arguments: '"a.ts"}' } },
                    { index: 1, id: "b", function: { name: "rch", arguments: '"needle"}' } },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
          },
          {
            choices: [],
            usage: { prompt_tokens: 30, prompt_cache_hit_tokens: 9, completion_tokens: 6 },
          },
        ],
        true,
      ),
    )

    const events = await collect(streamResponse(request()))

    expect(events).toEqual([
      { type: "text_delta", text: "Hel" },
      { type: "reasoning_summary_delta", text: "Think " },
      { type: "text_delta", text: "lo" },
      { type: "reasoning_summary_delta", text: "done" },
      {
        type: "item_done",
        item: {
          type: "reasoning",
          summary: "Think done",
          replay: { provider: "deepseek", data: { reasoning_content: "Think done" } },
        },
      },
      {
        type: "item_done",
        item: {
          type: "assistant_message",
          text: "Hello",
          replay: { provider: "deepseek", model: "deepseek-reasoner", data: { content: "Hello" } },
        },
      },
      {
        type: "item_done",
        item: {
          type: "tool_call",
          callId: "call-a",
          name: "read",
          args: { path: "a.ts" },
          replay: {
            provider: "deepseek",
            model: "deepseek-reasoner",
            data: {
              id: "call-a",
              type: "function",
              function: { name: "read", arguments: '{"path":"a.ts"}' },
            },
          },
        },
      },
      {
        type: "item_done",
        item: {
          type: "tool_call",
          callId: "call-b",
          name: "search",
          args: { query: "needle" },
          replay: {
            provider: "deepseek",
            model: "deepseek-reasoner",
            data: {
              id: "call-b",
              type: "function",
              function: { name: "search", arguments: '{"query":"needle"}' },
            },
          },
        },
      },
      {
        type: "done",
        usage: { totalInputTokens: 30, cacheReadInputTokens: 9, outputTokens: 6 },
      },
    ])

    expect(keyRequests).toBe(1)
    expect(requests).toHaveLength(1)
    const captured = requests[0]
    if (!captured) throw new Error("DeepSeek request was not captured")
    expect(captured.path).toBe("/chat/completions")
    expect(captured.key).toBe("secret-key")
    expect(captured.init.method).toBe("POST")
    expect(new Headers(captured.init.headers).get("accept")).toBe("text/event-stream")
    if (typeof captured.init.body !== "string") throw new Error("DeepSeek request body was not a string")
    expect(JSON.parse(captured.init.body)).toEqual({
      model: "deepseek-reasoner",
      messages: [
        { role: "system", content: "Answer precisely" },
        { role: "user", content: "inspect" },
      ],
      stream: true,
      stream_options: { include_usage: true },
      user_id: "session-456",
      thinking: { type: "enabled" },
      reasoning_effort: "low",
      tools: [
        {
          type: "function",
          function: {
            name: "read",
            description: "Read a file",
            parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
          },
        },
      ],
      tool_choice: "auto",
    })
  })

  test("reports insufficient provider capacity after a terminal frame", async () => {
    responses.push(
      sse(
        [
          {
            choices: [{ delta: {}, finish_reason: "insufficient_system_resource" }],
          },
        ],
        true,
      ),
    )

    await expect(collect(streamResponse(request()))).rejects.toMatchObject({
      message: "DeepSeek had insufficient capacity to complete the response",
      retryable: true,
    })
  })

  test("surfaces provider error frames", async () => {
    responses.push(sse([{ error: { message: "service unavailable" } }], true))

    let thrown: unknown
    try {
      await collect(streamResponse(request()))
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(ProviderError)
    if (!(thrown instanceof ProviderError)) throw new Error("expected ProviderError")
    expect(thrown.message).toBe("service unavailable")
    expect(thrown.retryable).toBe(true)
  })

  test("rejects a stream that ends before the done sentinel", async () => {
    responses.push(
      sse([
        {
          choices: [{ delta: { content: "partial" }, finish_reason: null }],
        },
      ]),
    )

    await expect(collect(streamResponse(request()))).rejects.toMatchObject({
      message: "DeepSeek stream ended unexpectedly",
      retryable: true,
    })
  })
})
