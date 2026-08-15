import { appEnvVar, appInfo } from "../../app-info"
import { ProviderError } from "../../providers/errors"
import { errorDetail, httpError, sseEvents, streamError } from "../../providers/transport"
import type { StreamEvent, StreamRequest } from "../../providers/types"
import { chatGptFetch } from "./api"
import { resolveModel } from "./models"
import { PROVIDER_ID } from "./oauth"
import { buildInput, parseOutputItem, parseSseEvent } from "./wire"

function buildHeaders(sessionId: string): Record<string, string> {
  return {
    "openai-beta": "responses=experimental",
    accept: "text/event-stream",
    "content-type": "application/json",
    "session-id": sessionId,
    "x-client-request-id": crypto.randomUUID(),
  }
}

function buildBody(request: StreamRequest): string {
  const resolved = resolveModel(request.model)
  return JSON.stringify({
    model: resolved.model,
    ...(resolved.serviceTier ? { service_tier: resolved.serviceTier } : {}),
    store: false,
    stream: true,
    instructions: request.instructions,
    input: buildInput(request.input, { provider: PROVIDER_ID, model: request.conversationModel ?? request.model }),
    tools: request.tools.map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      strict: false,
    })),
    tool_choice: request.toolChoice,
    parallel_tool_calls: true,
    reasoning: { effort: request.thinking ?? "medium", summary: "auto" },
    include: ["reasoning.encrypted_content"],
    prompt_cache_key: request.cacheKey,
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
  const response = await chatGptFetch("/responses", {
    method: "POST",
    headers: buildHeaders(request.sessionId),
    body: buildBody(request),
    signal: request.signal,
  })
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
          throw new ProviderError(event.message, { retryable: event.retryable })
      }
      if (terminal) break
    }
  } catch (error) {
    streamError("ChatGPT", error, request.signal)
  }
  if (!terminal) throw new ProviderError("ChatGPT stream ended unexpectedly", { retryable: true })
}
