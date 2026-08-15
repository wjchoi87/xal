import { beforeEach, describe, expect, mock, test } from "bun:test"
import type { StreamEvent, StreamRequest } from "../../providers/types"

interface CapturedRequest {
  path: string
  key: string
  init: RequestInit
}

const requests: CapturedRequest[] = []
const responses: Response[] = []

mock.module("./api", () => ({
  PROVIDER_ID: "alibaba-cloud",
  async alibabaCloudFetch(path: string, key: string, init: RequestInit = {}): Promise<Response> {
    requests.push({ path, key, init })
    const response = responses.shift()
    if (!response) throw new Error("missing mocked Alibaba Cloud response")
    return response
  },
}))

mock.module("./auth", () => ({
  async apiKey(): Promise<string> {
    return "secret-key"
  },
}))

const { streamResponse } = await import("./transport")

function request(): StreamRequest {
  return {
    model: "qwen3.7-plus",
    thinking: "high",
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

function sse(frames: unknown[]): Response {
  return new Response(`${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")}data: [DONE]\n\n`, {
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
})

describe("Alibaba Cloud transport", () => {
  test("streams reasoning, text, tool calls, and cached usage", async () => {
    responses.push(
      sse([
        {
          choices: [
            {
              delta: {
                reasoning_content: "Think ",
                tool_calls: [{ index: 0, id: "call-", function: { name: "re", arguments: '{"path":' } }],
              },
            },
          ],
        },
        {
          choices: [
            {
              delta: {
                content: "Done",
                tool_calls: [{ index: 0, id: "1", function: { name: "ad", arguments: '"a.ts"}' } }],
              },
              finish_reason: "tool_calls",
            },
          ],
        },
        {
          choices: [],
          usage: { prompt_tokens: 30, prompt_tokens_details: { cached_tokens: 9 }, completion_tokens: 6 },
        },
      ]),
    )

    expect(await collect(streamResponse(request()))).toEqual([
      { type: "reasoning_summary_delta", text: "Think " },
      { type: "text_delta", text: "Done" },
      {
        type: "item_done",
        item: {
          type: "reasoning",
          summary: "Think ",
          replay: { provider: "alibaba-cloud", data: { reasoning_content: "Think " } },
        },
      },
      {
        type: "item_done",
        item: {
          type: "assistant_message",
          text: "Done",
          replay: { provider: "alibaba-cloud", model: "qwen3.7-plus", data: { content: "Done" } },
        },
      },
      {
        type: "item_done",
        item: {
          type: "tool_call",
          callId: "call-1",
          name: "read",
          args: { path: "a.ts" },
          replay: {
            provider: "alibaba-cloud",
            model: "qwen3.7-plus",
            data: {
              id: "call-1",
              type: "function",
              function: { name: "read", arguments: '{"path":"a.ts"}' },
            },
          },
        },
      },
      { type: "done", usage: { totalInputTokens: 30, cacheReadInputTokens: 9, outputTokens: 6 } },
    ])

    const captured = requests[0]
    if (!captured) throw new Error("Alibaba Cloud request was not captured")
    expect(captured.path).toBe("/chat/completions")
    expect(captured.key).toBe("secret-key")
    if (typeof captured.init.body !== "string") throw new Error("Alibaba Cloud request body was not a string")
    expect(JSON.parse(captured.init.body)).toEqual({
      model: "qwen3.7-plus",
      messages: [
        { role: "system", content: "Answer precisely" },
        { role: "user", content: "inspect" },
      ],
      stream: true,
      stream_options: { include_usage: true },
      enable_thinking: true,
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

  test("omits thinking configuration for models without configurable thinking", async () => {
    responses.push(
      sse([
        {
          choices: [{ delta: { content: "Done" }, finish_reason: "stop" }],
        },
      ]),
    )
    const withoutThinking = request()
    withoutThinking.model = "qwen3-coder-plus"
    withoutThinking.thinking = undefined

    await collect(streamResponse(withoutThinking))

    const captured = requests[0]
    if (!captured || typeof captured.init.body !== "string") {
      throw new Error("Alibaba Cloud request body was not captured")
    }
    expect(JSON.parse(captured.init.body)).not.toHaveProperty("enable_thinking")
  })
})
