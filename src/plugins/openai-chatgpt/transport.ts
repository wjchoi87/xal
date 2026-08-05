import { appInfo } from "../../app-info"
import type { StreamEvent, StreamRequest } from "../../providers/types"
import { ensureAccessToken } from "./oauth"
import { parseErrorDetail, parseFunctionCall, parseSseEvent } from "./wire"

const RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses"

export class RateLimitError extends Error {
  constructor(message: string, readonly retryAfterSeconds?: number) {
    super(message)
  }
}

function buildHeaders(access: string, accountId: string, sessionId: string): Record<string, string> {
  return {
    authorization: `Bearer ${access}`,
    "chatgpt-account-id": accountId,
    "openai-beta": "responses=experimental",
    originator: appInfo.name,
    accept: "text/event-stream",
    "content-type": "application/json",
    "session-id": sessionId,
    "x-client-request-id": crypto.randomUUID(),
    "user-agent": `${appInfo.name}/${appInfo.version}`,
  }
}

function buildBody(request: StreamRequest): string {
  return JSON.stringify({
    model: request.model,
    store: false,
    stream: true,
    instructions: request.instructions,
    input: request.input,
    tools: request.tools.map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      strict: false,
    })),
    tool_choice: "auto",
    parallel_tool_calls: true,
    reasoning: { effort: "medium", summary: "auto" },
    include: ["reasoning.encrypted_content"],
    prompt_cache_key: request.sessionId,
  })
}

async function raiseForStatus(response: Response): Promise<never> {
  const text = await response.text().catch(() => "")
  if (response.status === 404 && /usage_limit_reached|usage_not_included|rate_limit_exceeded/.test(text)) {
    throw new RateLimitError("usage limit reached for your ChatGPT plan — try again later")
  }
  if (response.status === 429) {
    const retryAfter = Number(response.headers.get("retry-after")) || undefined
    throw new RateLimitError(
      retryAfter ? `rate limited — retry in ${retryAfter}s` : "rate limited — try again shortly",
      retryAfter,
    )
  }
  const detail = parseErrorDetail(text) ?? text.slice(0, 500)
  if (/model is not supported/i.test(detail)) {
    throw new Error(
      `${detail} — run \`${appInfo.name} models\` to see accepted models, or set ${appInfo.name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_MODEL`,
    )
  }
  throw new Error(`request failed (${response.status}): ${detail}`)
}

async function* sseJsonEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const decoder = new TextDecoder()
  const reader = body.getReader()
  let buffer = ""
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let separatorIndex: number
      while ((separatorIndex = buffer.indexOf("\n\n")) !== -1) {
        const rawEvent = buffer.slice(0, separatorIndex)
        buffer = buffer.slice(separatorIndex + 2)
        const data = rawEvent
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("")
        if (!data || data === "[DONE]") continue
        try {
          yield JSON.parse(data) as unknown
        } catch {}
      }
    }
  } finally {
    reader.releaseLock()
  }
}

export async function* streamResponse(request: StreamRequest): AsyncGenerator<StreamEvent> {
  let auth = await ensureAccessToken()
  const doFetch = () =>
    fetch(RESPONSES_URL, {
      method: "POST",
      headers: buildHeaders(auth.access, auth.accountId, request.sessionId),
      body: buildBody(request),
      signal: request.signal,
    })

  let response = await doFetch()
  if (response.status === 401) {
    auth = await ensureAccessToken(true)
    response = await doFetch()
  }
  if (!response.ok) await raiseForStatus(response)
  if (!response.body) throw new Error("response had no body")

  let terminal = false
  for await (const raw of sseJsonEvents(response.body)) {
    const event = parseSseEvent(raw)
    if (!event) continue
    switch (event.type) {
      case "output_text_delta":
        yield { type: "text_delta", text: event.delta }
        break
      case "reasoning_summary_delta":
        yield { type: "reasoning_summary_delta", text: event.delta }
        break
      case "reasoning_delta":
        yield { type: "reasoning_delta", text: event.delta }
        break
      case "item_done": {
        yield { type: "item_done", item: event.item }
        const call = parseFunctionCall(event.item)
        if (call) yield { type: "tool_call", callId: call.callId, name: call.name, args: call.args }
        break
      }
      case "terminal":
        terminal = true
        yield { type: "done", usage: event.usage }
        break
      case "failure":
        throw new Error(event.message)
    }
    if (terminal) break
  }
  if (!terminal) throw new Error("stream ended unexpectedly")
}
