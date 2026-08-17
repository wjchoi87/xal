import { describe, expect, test } from "bun:test"
import {
  buildInput,
  parseDeviceAuthorization,
  parseDeviceToken,
  parseOutputItem,
  parseSseEvent,
  parseTokenResponse,
} from "./wire"

const target = { provider: "xai", model: "grok-4.5" }

describe("xAI OAuth wire parsing", () => {
  test("parses a device authorization and prefers the complete verification URI", () => {
    expect(
      parseDeviceAuthorization({
        device_code: "device",
        user_code: "ABCD-1234",
        verification_uri: "https://accounts.x.ai/oauth2/device",
        verification_uri_complete: "https://accounts.x.ai/oauth2/device?user_code=ABCD-1234",
        interval: 5,
        expires_in: 900,
      }),
    ).toEqual({
      deviceCode: "device",
      userCode: "ABCD-1234",
      verificationUri: "https://accounts.x.ai/oauth2/device",
      verificationUriComplete: "https://accounts.x.ai/oauth2/device?user_code=ABCD-1234",
      intervalSeconds: 5,
      expiresInSeconds: 900,
    })
  })

  test("drops a non-positive interval so the caller applies the RFC 8628 default", () => {
    const device = parseDeviceAuthorization({
      device_code: "device",
      user_code: "ABCD-1234",
      verification_uri: "https://accounts.x.ai/oauth2/device",
      interval: 0,
      expires_in: 900,
    })
    expect(device.intervalSeconds).toBeUndefined()
  })

  test.each(["http://accounts.x.ai/oauth2/device", "file:///etc/passwd", "not a url"])(
    "rejects an untrusted verification URI: %s",
    (verificationUri) => {
      expect(() =>
        parseDeviceAuthorization({
          device_code: "device",
          user_code: "ABCD-1234",
          verification_uri: verificationUri,
          expires_in: 900,
        }),
      ).toThrow("untrusted verification URI")
    },
  )

  test("maps device token polling outcomes", () => {
    expect(parseDeviceToken({ error: "authorization_pending" }, false)).toEqual({ type: "pending" })
    expect(parseDeviceToken({ error: "slow_down", interval: 10 }, false)).toEqual({
      type: "slow_down",
      intervalSeconds: 10,
    })
    expect(parseDeviceToken({ error: "access_denied" }, false)).toEqual({
      type: "failed",
      message: "xAI device authorization was denied",
    })
    expect(parseDeviceToken({ error: "expired_token" }, false).type).toBe("failed")
    expect(parseDeviceToken({ access_token: "at", refresh_token: "rt", expires_in: 21_600 }, true)).toEqual({
      type: "complete",
      tokens: { access: "at", refresh: "rt", expiresInSeconds: 21_600 },
    })
  })

  test("leaves a missing refresh token and lifetime for the caller to resolve", () => {
    expect(parseTokenResponse({ access_token: "at" })).toEqual({
      access: "at",
      refresh: undefined,
      expiresInSeconds: undefined,
    })
    expect(() => parseTokenResponse({ refresh_token: "rt" })).toThrow("no access_token")
  })
})

describe("xAI Responses wire parsing", () => {
  test("parses text, reasoning, and terminal usage events", () => {
    expect(parseSseEvent({ type: "response.output_text.delta", delta: "hi" })).toEqual({
      type: "output_text_delta",
      delta: "hi",
    })
    expect(parseSseEvent({ type: "response.reasoning_text.delta", delta: "think" })).toEqual({
      type: "reasoning_delta",
      delta: "think",
    })
    expect(
      parseSseEvent({
        type: "response.completed",
        response: { usage: { input_tokens: 10, output_tokens: 4, input_tokens_details: { cached_tokens: 6 } } },
      }),
    ).toEqual({
      type: "terminal",
      usage: { totalInputTokens: 10, cacheReadInputTokens: 6, outputTokens: 4 },
    })
  })

  test("classifies failures by retryability", () => {
    expect(parseSseEvent({ type: "response.failed", response: { error: { message: "overloaded" } } })).toEqual({
      type: "failure",
      message: "overloaded",
      retryable: true,
    })
    expect(parseSseEvent({ type: "error", message: "bad request" })).toEqual({
      type: "failure",
      message: "bad request",
      retryable: false,
    })
  })

  test("parses assistant, reasoning, and tool call output items", () => {
    const message = { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] }
    expect(parseOutputItem(message, target)).toEqual({
      type: "assistant_message",
      text: "done",
      replay: { provider: "xai", model: "grok-4.5", data: message },
    })
    expect(parseOutputItem({ type: "reasoning", summary: [{ type: "summary_text", text: "why" }] }, target)).toEqual({
      type: "reasoning",
      summary: "why",
    })
    const call = { type: "function_call", call_id: "call-1", name: "read", arguments: '{"path":"a.ts"}' }
    expect(parseOutputItem(call, target)).toEqual({
      type: "tool_call",
      callId: "call-1",
      name: "read",
      args: { path: "a.ts" },
      replay: { provider: "xai", model: "grok-4.5", data: call },
    })
  })

  test("rejects an incomplete tool call", () => {
    expect(() => parseOutputItem({ type: "function_call", name: "read" }, target)).toThrow("incomplete")
  })
})

describe("xAI Responses input", () => {
  test("drops reasoning history and attaches images to user turns", () => {
    expect(
      buildInput(
        [
          {
            type: "user_message",
            text: "look",
            images: [{ mediaType: "image/png", data: "AAA" }],
          },
          { type: "reasoning", summary: "internal", replay: { provider: "xai", data: { type: "reasoning" } } },
          { type: "assistant_message", text: "sure" },
          { type: "tool_call", callId: "call-1", name: "read", args: { path: "a.ts" } },
          { type: "tool_result", callId: "call-1", output: "contents" },
        ],
        target,
      ),
    ).toEqual([
      {
        role: "user",
        content: [
          { type: "input_text", text: "look" },
          { type: "input_image", image_url: "data:image/png;base64,AAA", detail: "auto" },
        ],
      },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "sure" }] },
      { type: "function_call", call_id: "call-1", name: "read", arguments: '{"path":"a.ts"}' },
      { type: "function_call_output", call_id: "call-1", output: "contents" },
    ])
  })

  test("replays provider items verbatim when they belong to the same target", () => {
    const data = { type: "function_call", call_id: "call-9", name: "read", arguments: "{}" }
    expect(
      buildInput(
        [{ type: "tool_call", callId: "call-9", name: "read", args: {}, replay: { provider: "xai", data } }],
        target,
      ),
    ).toEqual([data])
  })
})
