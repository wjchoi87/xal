import { describe, expect, mock, test } from "bun:test"
import type { StreamRequest } from "../../providers/types"

const captured: { body: string }[] = []

mock.module("../../providers/chat-completions", () => ({
  streamChatCompletions(request: StreamRequest, provider: { requestOptions(request: StreamRequest): unknown }) {
    captured.push({ body: JSON.stringify(provider.requestOptions(request)) })
    return (async function* () {})()
  },
}))

const { streamResponse } = await import("./transport")

function request(thinking?: StreamRequest["thinking"]): StreamRequest {
  return {
    instructions: "",
    tools: [],
    cacheKey: "key",
    model: "anthropic/claude-opus-5",
    input: [],
    toolChoice: "auto",
    sessionId: "session",
    thinking,
  }
}

async function optionsFor(thinking?: StreamRequest["thinking"]): Promise<Record<string, unknown>> {
  captured.length = 0
  for await (const _ of streamResponse("profile", request(thinking))) void _
  return JSON.parse(captured[0]!.body) as Record<string, unknown>
}

describe("request options", () => {
  test("disables reasoning for none", async () => {
    expect(await optionsFor("none")).toMatchObject({ reasoning: { enabled: false } })
  })

  test("passes through supported effort levels", async () => {
    expect(await optionsFor("medium")).toMatchObject({ reasoning: { effort: "medium" } })
  })

  test("clamps efforts above high, which OpenRouter does not accept", async () => {
    expect(await optionsFor("max")).toMatchObject({ reasoning: { effort: "high" } })
  })

  test("always asks for usage accounting", async () => {
    expect(await optionsFor("high")).toMatchObject({ usage: { include: true } })
  })
})
