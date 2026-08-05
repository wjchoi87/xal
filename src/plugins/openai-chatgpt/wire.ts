import { asNumber, asString, isRecord } from "../../lib/json"
import type { ConversationItem, Usage } from "../../providers/types"

export type WireSseEvent =
  | { type: "output_text_delta"; delta: string }
  | { type: "reasoning_summary_delta"; delta: string }
  | { type: "reasoning_delta"; delta: string }
  | { type: "item_done"; item: ConversationItem }
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
      if (!isRecord(raw.item)) return undefined
      return { type: "item_done", item: raw.item }
    }
    case "response.completed":
    case "response.done":
    case "response.incomplete": {
      const usageRaw = isRecord(raw.response) ? raw.response.usage : undefined
      if (!isRecord(usageRaw)) return { type: "terminal" }
      return {
        type: "terminal",
        usage: { inputTokens: asNumber(usageRaw.input_tokens), outputTokens: asNumber(usageRaw.output_tokens) },
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

export interface WireFunctionCall {
  callId: string
  name: string
  args: Record<string, unknown>
}

export function parseFunctionCall(item: ConversationItem): WireFunctionCall | undefined {
  if (item.type !== "function_call") return undefined
  const callId = asString(item.call_id)
  const name = asString(item.name)
  if (!callId || !name) return undefined
  let args: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(asString(item.arguments) ?? "{}")
    if (isRecord(parsed)) args = parsed
  } catch {}
  return { callId, name, args }
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
