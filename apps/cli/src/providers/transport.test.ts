import { describe, expect, test } from "bun:test"
import { ProviderError } from "./errors"
import { httpError, parseToolArgs, sseEvents, type SseEvent } from "./transport"

function bytewiseStream(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text)
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (let index = 0; index < bytes.length; index++) {
        controller.enqueue(bytes.slice(index, index + 1))
      }
      controller.close()
    },
  })
}

async function collect(body: ReadableStream<Uint8Array>): Promise<SseEvent[]> {
  const events: SseEvent[] = []
  for await (const event of sseEvents(body)) events.push(event)
  return events
}

function thrownProviderError(run: () => unknown): ProviderError {
  try {
    run()
  } catch (error) {
    if (error instanceof ProviderError) return error
    throw error
  }
  throw new Error("expected ProviderError")
}

describe("provider transport", () => {
  test("parses byte-split UTF-8, CRLF, multiline data, and done frames", async () => {
    const body = bytewiseStream(
      ': keepalive\r\nretry: 1000\r\n\r\nevent: response\r\nid: 7\r\ndata: {"text":\r\ndata: "héllo 👋"}\r\n\r\nevent: finished\r\ndata: [DONE]\r\n\r\n',
    )

    expect(await collect(body)).toEqual([{ done: false, data: { text: "héllo 👋" } }, { done: true }])
  })

  test("rejects malformed complete SSE data", async () => {
    await expect(collect(bytewiseStream('data: {"broken":}\n\n'))).rejects.toThrow('malformed SSE data: {"broken":}')
  })

  test("rejects malformed tool argument JSON without retrying", () => {
    const error = thrownProviderError(() => parseToolArgs("Example", "write", '{"path":'))

    expect(error.message).toBe("Example tool call write had invalid JSON arguments")
    expect(error.retryable).toBe(false)
  })

  test("rejects non-object tool arguments without retrying", () => {
    for (const value of ["null", "[]", '"text"', "1"]) {
      const error = thrownProviderError(() => parseToolArgs("Example", "write", value))
      expect(error.message).toBe("Example tool call write arguments were not an object")
      expect(error.retryable).toBe(false)
    }
  })

  test("classifies HTTP failures and honors numeric retry-after", () => {
    const limited = httpError("Example", new Response(null, { status: 429, headers: { "retry-after": "2.5" } }), "")
    const unavailable = httpError("Example", new Response(null, { status: 503 }), "offline")
    const rejected = httpError("Example", new Response(null, { status: 400 }), "invalid request")

    expect(limited).toMatchObject({ retryable: true, retryAfterMs: 2_500 })
    expect(limited.message).toBe("Example rate limited — retry in 2.5s")
    expect(unavailable).toMatchObject({ retryable: true, retryAfterMs: undefined })
    expect(unavailable.message).toBe("Example request failed (503): offline")
    expect(rejected).toMatchObject({ retryable: false, retryAfterMs: undefined })
    expect(rejected.message).toBe("Example request failed (400): invalid request")
  })
})
