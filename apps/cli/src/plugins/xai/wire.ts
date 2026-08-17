import { asNumber, asString, isJsonObject, isRecord, type JsonObject, type JsonValue } from "../../lib/json"
import { replayMatches, type ConversationTarget } from "../../providers/conversation"
import { parseToolArgs } from "../../providers/transport"
import type { ConversationItem, ProviderOutputItem, ProviderReplay, Usage } from "../../providers/types"
import { PROVIDER_NAME } from "./api"

export type WireSseEvent =
  | { type: "output_text_delta"; delta: string }
  | { type: "reasoning_delta"; delta: string }
  | { type: "item_done"; item: JsonObject }
  | { type: "terminal"; usage?: Usage }
  | { type: "failure"; message: string; retryable: boolean }

const TRANSIENT_FAILURE = /overloaded|rate.?limit|server.?error|service.?unavailable|internal.?error|timeout|try again/i

function failure(message: string, code?: string): WireSseEvent {
  return { type: "failure", message, retryable: TRANSIENT_FAILURE.test(`${code ?? ""} ${message}`) }
}

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
    case "response.reasoning_text.delta":
    case "response.reasoning_summary_text.delta": {
      const delta = asString(raw.delta)
      if (!delta) return undefined
      return { type: "reasoning_delta", delta }
    }
    case "response.output_item.done": {
      if (!isJsonObject(raw.item)) return failure("xAI response item was not valid JSON")
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
          outputTokens: asNumber(usageRaw.output_tokens),
        },
      }
    }
    case "response.failed": {
      const error = isRecord(raw.response) ? raw.response.error : undefined
      const message = isRecord(error) ? asString(error.message) : undefined
      const code = isRecord(error) ? asString(error.code) : undefined
      return failure(message ?? "xAI response failed", code)
    }
    case "error": {
      const nested = isRecord(raw.error) ? asString(raw.error.message) : undefined
      const code = asString(raw.code) ?? (isRecord(raw.error) ? asString(raw.error.code) : undefined)
      return failure(asString(raw.message) ?? nested ?? "xAI stream error", code)
    }
    default:
      return undefined
  }
}

function blockText(value: JsonValue | undefined, type: string): string {
  if (!Array.isArray(value)) throw new Error("xAI response message content was not an array")
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
      if (asString(item.role) !== "assistant") throw new Error("xAI response message had an invalid role")
      return {
        type: "assistant_message",
        text: blockText(item.content, "output_text"),
        replay: { provider: target.provider, model: target.model, data: item },
      }
    }
    case "reasoning":
      return { type: "reasoning", summary: blockText(item.summary, "summary_text") }
    case "function_call": {
      const callId = asString(item.call_id)
      const name = asString(item.name)
      const argumentsText = asString(item.arguments)
      if (!callId || !name || argumentsText === undefined) throw new Error("xAI response tool call was incomplete")
      return {
        type: "tool_call",
        callId,
        name,
        args: parseToolArgs(PROVIDER_NAME, name, argumentsText),
        replay: { provider: target.provider, model: target.model, data: item },
      }
    }
    default:
      return undefined
  }
}

function replayData(item: { replay?: ProviderReplay }, target: ConversationTarget): JsonObject | undefined {
  return replayMatches(item.replay, target) ? item.replay.data : undefined
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
                detail: "auto",
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
      case "reasoning":
        return []
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

export interface DeviceAuthorization {
  deviceCode: string
  userCode: string
  verificationUri: string
  verificationUriComplete?: string
  intervalSeconds?: number
  expiresInSeconds: number
}

function httpsUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error("xAI device authorization returned an untrusted verification URI")
  }
  if (url.protocol !== "https:") throw new Error("xAI device authorization returned an untrusted verification URI")
  return url.href
}

function positiveNumber(raw: unknown): number | undefined {
  const value = asNumber(raw)
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : undefined
}

export function parseDeviceAuthorization(raw: unknown): DeviceAuthorization {
  if (!isRecord(raw)) throw new Error("xAI device authorization response was not an object")
  const deviceCode = asString(raw.device_code)
  const userCode = asString(raw.user_code)
  const verificationUri = asString(raw.verification_uri)
  const expiresInSeconds = positiveNumber(raw.expires_in)
  if (!deviceCode || !userCode || !verificationUri || expiresInSeconds === undefined) {
    throw new Error("xAI device authorization response was incomplete")
  }
  const complete = asString(raw.verification_uri_complete)
  return {
    deviceCode,
    userCode,
    verificationUri: httpsUrl(verificationUri),
    ...(complete ? { verificationUriComplete: httpsUrl(complete) } : {}),
    intervalSeconds: positiveNumber(raw.interval),
    expiresInSeconds,
  }
}

export type DeviceTokenResult =
  | { type: "complete"; tokens: TokenResponse }
  | { type: "pending" }
  | { type: "slow_down"; intervalSeconds?: number }
  | { type: "failed"; message: string }

export interface TokenResponse {
  access: string
  refresh?: string
  expiresInSeconds?: number
}

export function parseTokenResponse(raw: unknown): TokenResponse {
  if (!isRecord(raw)) throw new Error("xAI token response was not an object")
  const access = asString(raw.access_token)
  if (!access) throw new Error("xAI token response had no access_token")
  return { access, refresh: asString(raw.refresh_token), expiresInSeconds: positiveNumber(raw.expires_in) }
}

export function tokenErrorDetail(raw: unknown): string | undefined {
  if (!isRecord(raw)) return undefined
  const error = asString(raw.error)
  const description = asString(raw.error_description)
  const detail = [error, description].filter(Boolean).join(": ")
  return detail || undefined
}

export function parseDeviceToken(raw: unknown, ok: boolean): DeviceTokenResult {
  if (ok) return { type: "complete", tokens: parseTokenResponse(raw) }
  const error = isRecord(raw) ? asString(raw.error) : undefined
  switch (error) {
    case "authorization_pending":
      return { type: "pending" }
    case "slow_down":
      return { type: "slow_down", intervalSeconds: isRecord(raw) ? positiveNumber(raw.interval) : undefined }
    case "access_denied":
    case "authorization_denied":
      return { type: "failed", message: "xAI device authorization was denied" }
    case "expired_token":
      return { type: "failed", message: "xAI device code expired — start the connection again" }
    default:
      return { type: "failed", message: `xAI device login failed: ${tokenErrorDetail(raw) ?? "unknown error"}` }
  }
}
