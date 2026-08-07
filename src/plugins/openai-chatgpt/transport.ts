import { appEnvVar, appInfo } from "../../app-info"
import { ProviderError } from "../../providers/errors"
import { errorDetail, httpError, providerFetch, sseEvents, streamError } from "../../providers/transport"
import type { StreamEvent, StreamRequest } from "../../providers/types"
import { ensureAccessToken, PROVIDER_ID } from "./oauth"
import { buildInput, parseOutputItem, parseSseEvent } from "./wire"

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

async function raiseForStatus(response: Response): Promise<never> {
  const text = await response.text().catch(() => "")
  if (response.status === 404 && /usage_limit_reached|usage_not_included|rate_limit_exceeded/.test(text)) {
    throw new ProviderError("usage limit reached for your ChatGPT plan — try again later", { retryable: false })
  }
  const detail = errorDetail(text) ?? text.slice(0, 500)
  if (/model is not supported/i.test(detail)) {
    throw new ProviderError(
      `${detail} — run \`${appInfo.name} models\` to see accepted models, or set ${appEnvVar("MODEL")}`,
      { retryable: false },
    )
  }
  throw httpError("ChatGPT", response, detail)
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

  let response = await providerFetch("ChatGPT", doFetch, request.signal)
  if (response.status === 401) {
    auth = await ensureAccessToken(true)
    response = await providerFetch("ChatGPT", doFetch, request.signal)
  }
  if (!response.ok) await raiseForStatus(response)
  if (!response.body) throw new ProviderError("ChatGPT response had no body", { retryable: true })

  let terminal = false
  try {
    for await (const raw of sseEvents(response.body)) {
      if (raw.done) continue
      const event = parseSseEvent(raw.data)
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
    streamError("ChatGPT", error, request.signal)
  }
  if (!terminal) throw new ProviderError("ChatGPT stream ended unexpectedly", { retryable: true })
}
