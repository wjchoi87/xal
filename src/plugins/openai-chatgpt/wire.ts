import { asNumber, asString, isJsonObject, isRecord, type JsonObject, type JsonValue } from "../../lib/json"
import type { ConversationItem, ProviderOutputItem, ProviderReplay, Usage } from "../../providers/types"
import type { ConversationTarget } from "../../providers/conversation"

export type WireSseEvent =
  | { type: "output_text_delta"; delta: string }
  | { type: "reasoning_summary_delta"; delta: string }
  | { type: "reasoning_delta"; delta: string }
  | { type: "item_done"; item: JsonObject }
  | { type: "terminal"; usage?: Usage }
  | { type: "failure"; message: string }

export function parseSseEvent(raw: unknown): WireSseEvent | undefined {
  if (!isRecord(raw)) return undefined
  const type = asString(raw.type)
  if (!type) return undefined

  switch (type) {
    case "response.output_text.delta": {
      const delta = asString(raw.delta)
      if (!delta) return undefined
      return { type: "output_text_delta", delta }
    }
    case "response.reasoning_summary_text.delta": {
      const delta = asString(raw.delta)
      if (!delta) return undefined
      return { type: "reasoning_summary_delta", delta }
    }
    case "response.reasoning_text.delta": {
      const delta = asString(raw.delta)
      if (!delta) return undefined
      return { type: "reasoning_delta", delta }
    }
    case "response.output_item.done": {
      if (!isJsonObject(raw.item)) return { type: "failure", message: "response item was not valid JSON" }
      return { type: "item_done", item: raw.item }
    }
    case "response.completed":
    case "response.done":
    case "response.incomplete": {
      const usageRaw = isRecord(raw.response) ? raw.response.usage : undefined
      if (!isRecord(usageRaw)) return { type: "terminal" }
      const inputDetails = isRecord(usageRaw.input_tokens_details) ? usageRaw.input_tokens_details : undefined
      return {
        type: "terminal",
        usage: {
          totalInputTokens: asNumber(usageRaw.input_tokens),
          cacheReadInputTokens: inputDetails ? asNumber(inputDetails.cached_tokens) : undefined,
          cacheWriteInputTokens: inputDetails ? asNumber(inputDetails.cache_write_tokens) : undefined,
          outputTokens: asNumber(usageRaw.output_tokens),
        },
      }
    }
    case "response.failed": {
      const error = isRecord(raw.response) ? raw.response.error : undefined
      const message = isRecord(error) ? asString(error.message) : undefined
      return { type: "failure", message: message ?? "response failed" }
    }
    case "error": {
      const nested = isRecord(raw.error) ? asString(raw.error.message) : undefined
      return { type: "failure", message: asString(raw.message) ?? nested ?? "stream error" }
    }
    default:
      return undefined
  }
}

function replay(item: JsonObject, target: ConversationTarget): ProviderReplay {
  return { provider: target.provider, model: target.model, data: item }
}

function blockText(value: JsonValue | undefined, type: string): string {
  if (!Array.isArray(value)) throw new Error("response message content was not an array")
  return value
    .flatMap((block) => {
      if (!isRecord(block) || asString(block.type) !== type) return []
      const text = asString(block.text)
      return text === undefined ? [] : [text]
    })
    .join("")
}

export function parseOutputItem(item: JsonObject, target: ConversationTarget): ProviderOutputItem | undefined {
  switch (asString(item.type)) {
    case "message": {
      if (asString(item.role) !== "assistant") throw new Error("response message had an invalid role")
      return {
        type: "assistant_message",
        text: blockText(item.content, "output_text"),
        replay: replay(item, target),
      }
    }
    case "reasoning":
      return {
        type: "reasoning",
        summary: blockText(item.summary, "summary_text"),
        replay: replay(item, target),
      }
    case "function_call": {
      const callId = asString(item.call_id)
      const name = asString(item.name)
      const argumentsText = asString(item.arguments)
      if (!callId || !name || argumentsText === undefined) throw new Error("response tool call was incomplete")
      let args: unknown
      try {
        args = JSON.parse(argumentsText)
      } catch {
        throw new Error(`response tool call ${name} had invalid JSON arguments`)
      }
      if (!isJsonObject(args)) throw new Error(`response tool call ${name} arguments were not an object`)
      return { type: "tool_call", callId, name, args, replay: replay(item, target) }
    }
    default:
      return undefined
  }
}

function replayData(item: { replay?: ProviderReplay }, target: ConversationTarget): JsonObject | undefined {
  if (item.replay?.provider !== target.provider || item.replay.model !== target.model) return undefined
  return item.replay.data
}

export function buildInput(items: ConversationItem[], target: ConversationTarget): JsonObject[] {
  return items.flatMap((item): JsonObject[] => {
    switch (item.type) {
      case "user_message":
        return [
          {
            role: "user",
            content: [
              ...(item.text ? [{ type: "input_text", text: item.text }] : []),
              ...item.images.map((image) => ({
                type: "input_image",
                image_url: `data:${image.mediaType};base64,${image.data}`,
              })),
            ],
          },
        ]
      case "assistant_message":
        return [
          replayData(item, target) ?? {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: item.text }],
          },
        ]
      case "reasoning": {
        const data = replayData(item, target)
        return data ? [data] : []
      }
      case "tool_call":
        return [
          replayData(item, target) ?? {
            type: "function_call",
            call_id: item.callId,
            name: item.name,
            arguments: JSON.stringify(item.args),
          },
        ]
      case "tool_result":
        return [{ type: "function_call_output", call_id: item.callId, output: item.output }]
    }
  })
}

export interface TokenResponse {
  accessToken: string
  refreshToken?: string
  expiresInSeconds: number
}

export function parseTokenResponse(raw: unknown): TokenResponse {
  if (!isRecord(raw)) throw new Error("token response was not an object")
  const accessToken = asString(raw.access_token)
  const expiresInSeconds = asNumber(raw.expires_in)
  if (!accessToken || !expiresInSeconds) throw new Error("token response missing access_token or expires_in")
  return { accessToken, refreshToken: asString(raw.refresh_token), expiresInSeconds }
}

export function parseErrorDetail(text: string): string | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isRecord(parsed)) return undefined
  const nested = isRecord(parsed.error) ? asString(parsed.error.message) : undefined
  return nested ?? asString(parsed.detail)
}
