import { appInfo } from "../../app-info"
import { describeError } from "../../lib/error"
import { ProviderError } from "../../providers/errors"
import type { StreamEvent, StreamRequest } from "../../providers/types"
import { ensureAccessToken, PROVIDER_ID } from "./oauth"
import { buildInput, parseErrorDetail, parseOutputItem, parseSseEvent } from "./wire"

const RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses"

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
    input: buildInput(request.input, { provider: PROVIDER_ID, model: request.model }),
    tools: request.tools.map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      strict: false,
    })),
    tool_choice: "auto",
    parallel_tool_calls: true,
    reasoning: { effort: request.thinking ?? "medium", summary: "auto" },
    include: ["reasoning.encrypted_content"],
    prompt_cache_key: request.sessionId,
  })
}

function retryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000
  const date = Date.parse(value)
  if (Number.isNaN(date)) return undefined
  return Math.max(0, date - Date.now())
}

async function raiseForStatus(response: Response): Promise<never> {
  const text = await response.text().catch(() => "")
  if (response.status === 404 && /usage_limit_reached|usage_not_included|rate_limit_exceeded/.test(text)) {
    throw new ProviderError("usage limit reached for your ChatGPT plan — try again later", { retryable: false })
  }
  if (response.status === 429) {
    const delayMs = retryAfterMs(response.headers.get("retry-after"))
    throw new ProviderError(delayMs === undefined ? "rate limited" : `rate limited — retry in ${delayMs / 1_000}s`, {
      retryable: true,
      retryAfterMs: delayMs,
    })
  }
  const detail = parseErrorDetail(text) ?? text.slice(0, 500)
  if (/model is not supported/i.test(detail)) {
    throw new ProviderError(
      `${detail} — run \`${appInfo.name} models\` to see accepted models, or set ${appInfo.name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_MODEL`,
      { retryable: false },
    )
  }
  throw new ProviderError(`request failed (${response.status}): ${detail}`, {
    retryable: response.status === 408 || response.status >= 500,
    retryAfterMs: retryAfterMs(response.headers.get("retry-after")),
  })
}

async function fetchResponse(run: () => Promise<Response>, signal?: AbortSignal): Promise<Response> {
  try {
    return await run()
  } catch (error) {
    if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw error
    throw new ProviderError(`request failed: ${describeError(error)}`, { retryable: true })
  }
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

  let response = await fetchResponse(doFetch, request.signal)
  if (response.status === 401) {
    auth = await ensureAccessToken(true)
    response = await fetchResponse(doFetch, request.signal)
  }
  if (!response.ok) await raiseForStatus(response)
  if (!response.body) throw new ProviderError("response had no body", { retryable: true })

  let terminal = false
  try {
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
          const item = parseOutputItem(event.item, { provider: PROVIDER_ID, model: request.model })
          if (item) yield { type: "item_done", item }
          break
        }
        case "terminal":
          terminal = true
          yield { type: "done", usage: event.usage }
          break
        case "failure":
          throw new ProviderError(event.message, { retryable: false })
      }
      if (terminal) break
    }
  } catch (error) {
    if (request.signal?.aborted || error instanceof ProviderError) throw error
    throw new ProviderError(`stream failed: ${describeError(error)}`, { retryable: true })
  }
  if (!terminal) throw new ProviderError("stream ended unexpectedly", { retryable: true })
}
