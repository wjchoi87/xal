import { asNumber, asString, isJsonObject, isRecord, type JsonObject } from "../../lib/json"
import { replayMatches, type ConversationTarget } from "../../providers/conversation"
import { parseToolArgs } from "../../providers/transport"
import type { ConversationItem, ProviderReplay, ToolDefinition, Usage } from "../../providers/types"

export type WireEvent =
  | { type: "block_start"; index: number; block: JsonObject }
  | { type: "text_delta"; index: number; text: string }
  | { type: "thinking_delta"; index: number; text: string }
  | { type: "signature_delta"; index: number; signature: string }
  | { type: "input_json_delta"; index: number; partial: string }
  | { type: "block_stop"; index: number }
  | { type: "usage"; usage: Usage }
  | { type: "terminal"; stopReason?: string; outputTokens?: number }
  | { type: "message_stop" }
  | { type: "failure"; message: string; retryable: boolean }

const TRANSIENT_FAILURE = /overloaded|rate.?limit|api_error|timeout|try again/i
const CACHE_CONTROL = { type: "ephemeral" } as const

function failure(providerName: string, message: string, kind?: string): WireEvent {
  return {
    type: "failure",
    message,
    retryable: TRANSIENT_FAILURE.test(`${kind ?? ""} ${message}`),
  }
}

function usageFrom(raw: unknown): Usage | undefined {
  if (!isRecord(raw)) return undefined
  const input = asNumber(raw.input_tokens) ?? 0
  const cacheRead = asNumber(raw.cache_read_input_tokens) ?? 0
  const cacheWrite = asNumber(raw.cache_creation_input_tokens) ?? 0
  return {
    totalInputTokens: input + cacheRead + cacheWrite,
    cacheReadInputTokens: cacheRead,
    cacheWriteInputTokens: cacheWrite,
    outputTokens: asNumber(raw.output_tokens),
  }
}

export function parseSseEvent(providerName: string, raw: unknown): WireEvent | undefined {
  if (!isRecord(raw)) return undefined
  const type = asString(raw.type)
  if (!type) return undefined

  switch (type) {
    case "message_start": {
      const usage = isRecord(raw.message) ? usageFrom(raw.message.usage) : undefined
      return usage ? { type: "usage", usage } : undefined
    }
    case "content_block_start": {
      const index = asNumber(raw.index)
      if (index === undefined) return undefined
      if (!isJsonObject(raw.content_block))
        return failure(providerName, `${providerName} content block was not valid JSON`)
      return { type: "block_start", index, block: raw.content_block }
    }
    case "content_block_delta": {
      const index = asNumber(raw.index)
      if (index === undefined || !isRecord(raw.delta)) return undefined
      switch (asString(raw.delta.type)) {
        case "text_delta": {
          const text = asString(raw.delta.text)
          return text === undefined ? undefined : { type: "text_delta", index, text }
        }
        case "thinking_delta": {
          const text = asString(raw.delta.thinking)
          return text === undefined ? undefined : { type: "thinking_delta", index, text }
        }
        case "signature_delta": {
          const signature = asString(raw.delta.signature)
          return signature === undefined ? undefined : { type: "signature_delta", index, signature }
        }
        case "input_json_delta": {
          const partial = asString(raw.delta.partial_json)
          return partial === undefined ? undefined : { type: "input_json_delta", index, partial }
        }
        default:
          return undefined
      }
    }
    case "content_block_stop": {
      const index = asNumber(raw.index)
      return index === undefined ? undefined : { type: "block_stop", index }
    }
    case "message_delta": {
      const stopReason = isRecord(raw.delta) ? asString(raw.delta.stop_reason) : undefined
      const outputTokens = isRecord(raw.usage) ? asNumber(raw.usage.output_tokens) : undefined
      return { type: "terminal", stopReason, outputTokens }
    }
    case "message_stop":
      return { type: "message_stop" }
    case "error": {
      const error = isRecord(raw.error) ? raw.error : undefined
      const message = error ? asString(error.message) : undefined
      const kind = error ? asString(error.type) : undefined
      return failure(providerName, message ?? `${providerName} stream error`, kind)
    }
    default:
      return undefined
  }
}

export interface WireTool {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

export function buildTools(tools: ToolDefinition[]): WireTool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  }))
}

export function parseToolInput(providerName: string, name: string, partial: string): JsonObject {
  return parseToolArgs(providerName, name, partial.trim() === "" ? "{}" : partial)
}

function replayData(item: { replay?: ProviderReplay }, target: ConversationTarget): JsonObject | undefined {
  return replayMatches(item.replay, target) ? item.replay.data : undefined
}

function userContent(text: string, images: { mediaType: string; data: string }[]): JsonObject[] {
  const blocks: JsonObject[] = images.map((image) => ({
    type: "image",
    source: { type: "base64", media_type: image.mediaType, data: image.data },
  }))
  if (text) blocks.push({ type: "text", text })
  return blocks.length > 0 ? blocks : [{ type: "text", text: "(empty message)" }]
}

export function cacheBreakpoint(messages: JsonObject[]): JsonObject[] {
  const last = messages.at(-1)
  if (!last || !Array.isArray(last.content) || last.content.length === 0) return messages
  const content = last.content
  const block = content.at(-1)
  if (!isJsonObject(block)) return messages
  const marked: JsonObject = { ...block, cache_control: CACHE_CONTROL }
  return [...messages.slice(0, -1), { ...last, content: [...content.slice(0, -1), marked] }]
}

export function buildSystem(instructions: string): JsonObject[] {
  return [{ type: "text", text: instructions, cache_control: CACHE_CONTROL }]
}

export function buildMessages(items: ConversationItem[], target: ConversationTarget): JsonObject[] {
  const messages: JsonObject[] = []
  let assistant: JsonObject[] = []

  const flushAssistant = (): void => {
    if (assistant.length === 0) return
    messages.push({ role: "assistant", content: assistant })
    assistant = []
  }

  const pushUser = (content: JsonObject[]): void => {
    const last = messages.at(-1)
    if (last && Array.isArray(last.content) && last.role === "user") {
      last.content = [...last.content, ...content]
      return
    }
    messages.push({ role: "user", content })
  }

  for (const item of items) {
    switch (item.type) {
      case "user_message":
        flushAssistant()
        pushUser(userContent(item.modelText ?? item.text, item.images))
        break
      case "reasoning": {
        const data = replayData(item, target)
        if (data) assistant.push(data)
        break
      }
      case "assistant_message": {
        const data = replayData(item, target)
        if (data) assistant.push(data)
        else if (item.text) assistant.push({ type: "text", text: item.text })
        break
      }
      case "tool_call": {
        const data = replayData(item, target)
        assistant.push(data ?? { type: "tool_use", id: item.callId, name: item.name, input: item.args })
        break
      }
      case "tool_result":
        flushAssistant()
        pushUser([{ type: "tool_result", tool_use_id: item.callId, content: item.output }])
        break
    }
  }

  flushAssistant()
  return messages
}
