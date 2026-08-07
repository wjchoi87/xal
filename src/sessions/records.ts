import type { AgentEvent, DenialCause } from "../agent/events"
import { asBoolean, asNumber, asString, isJsonObject, isRecord } from "../lib/json"
import { isPermissionMode } from "../permissions/types"
import type { ConversationItem, ProviderReplay, Usage } from "../providers/types"
import type { SessionMeta, SessionRecord } from "./types"

export function isPersistable(event: AgentEvent): boolean {
  return parseEvent(event) !== undefined
}

function parseDenial(value: unknown): DenialCause | undefined {
  const denial = asString(value)
  if (denial === "user" || denial === "policy" || denial === "plan") return denial
  return undefined
}

function parseUsage(value: unknown): Usage | undefined {
  if (!isRecord(value)) return undefined
  return {
    totalInputTokens: asNumber(value.totalInputTokens),
    cacheReadInputTokens: asNumber(value.cacheReadInputTokens),
    cacheWriteInputTokens: asNumber(value.cacheWriteInputTokens),
    outputTokens: asNumber(value.outputTokens),
  }
}

function parseEvent(raw: unknown): AgentEvent | undefined {
  if (!isRecord(raw)) return undefined

  switch (asString(raw.type)) {
    case "user_message": {
      const text = asString(raw.text)
      if (text === undefined) return undefined
      return { type: "user_message", text, sentAt: asNumber(raw.sentAt) ?? 0 }
    }
    case "assistant_message": {
      const text = asString(raw.text)
      if (text === undefined) return undefined
      return { type: "assistant_message", text }
    }
    case "reasoning_summary": {
      const text = asString(raw.text)
      if (text === undefined) return undefined
      return { type: "reasoning_summary", text }
    }
    case "tool_finished": {
      const callId = asString(raw.callId)
      const tool = asString(raw.tool)
      const title = asString(raw.title)
      const output = asString(raw.output)
      if (!callId || !tool || title === undefined || output === undefined) return undefined
      return {
        type: "tool_finished",
        callId,
        tool,
        title,
        readOnly: asBoolean(raw.readOnly) ?? false,
        output,
        denial: parseDenial(raw.denial),
      }
    }
    case "turn_ended":
      return { type: "turn_ended", usage: parseUsage(raw.usage), context: parseUsage(raw.context) }
    case "turn_interrupted":
      return { type: "turn_interrupted" }
    case "mode_changed": {
      const mode = asString(raw.mode)
      if (!mode || !isPermissionMode(mode)) return undefined
      return { type: "mode_changed", mode }
    }
    case "model_changed": {
      const provider = asString(raw.provider)
      const model = asString(raw.model)
      if (!provider || !model) return undefined
      return { type: "model_changed", provider, model }
    }
    case "error": {
      const message = asString(raw.message)
      if (message === undefined) return undefined
      return { type: "error", message }
    }
    default:
      return undefined
  }
}

function parseMeta(raw: unknown): SessionMeta | undefined {
  if (!isRecord(raw)) return undefined
  if (asNumber(raw.version) !== 1) return undefined
  const id = asString(raw.id)
  const cwd = asString(raw.cwd)
  const provider = asString(raw.provider)
  const model = asString(raw.model)
  const mode = asString(raw.mode)
  if (!id || !cwd || !provider || !model || !mode || !isPermissionMode(mode)) return undefined
  return { version: 1, id, cwd, provider, model, mode, startedAt: asNumber(raw.startedAt) ?? 0 }
}

function parseReplay(raw: unknown): ProviderReplay | undefined {
  if (!isRecord(raw)) return undefined
  const provider = asString(raw.provider)
  const model = asString(raw.model)
  if (!provider || !model || !isJsonObject(raw.data)) return undefined
  return { provider, model, data: raw.data }
}

function replay(raw: Record<string, unknown>): ProviderReplay | undefined | false {
  if (raw.replay === undefined) return undefined
  return parseReplay(raw.replay) ?? false
}

function parseItem(raw: unknown): ConversationItem | undefined {
  if (!isRecord(raw)) return undefined

  switch (asString(raw.type)) {
    case "user_message": {
      const text = asString(raw.text)
      return text === undefined ? undefined : { type: "user_message", text }
    }
    case "assistant_message": {
      const text = asString(raw.text)
      const providerReplay = replay(raw)
      if (text === undefined || providerReplay === false) return undefined
      return { type: "assistant_message", text, replay: providerReplay }
    }
    case "reasoning": {
      const summary = asString(raw.summary)
      const providerReplay = replay(raw)
      if (summary === undefined || providerReplay === false) return undefined
      return { type: "reasoning", summary, replay: providerReplay }
    }
    case "tool_call": {
      const callId = asString(raw.callId)
      const name = asString(raw.name)
      const providerReplay = replay(raw)
      if (!callId || !name || !isJsonObject(raw.args) || providerReplay === false) return undefined
      return { type: "tool_call", callId, name, args: raw.args, replay: providerReplay }
    }
    case "tool_result": {
      const callId = asString(raw.callId)
      const name = asString(raw.name)
      const output = asString(raw.output)
      const isError = asBoolean(raw.isError)
      if (!callId || !name || output === undefined || isError === undefined) return undefined
      return { type: "tool_result", callId, name, output, isError }
    }
    default:
      return undefined
  }
}

export function parseRecord(line: string): SessionRecord | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return undefined
  }
  if (!isRecord(raw)) return undefined

  switch (asString(raw.type)) {
    case "meta": {
      const meta = parseMeta(raw.meta)
      return meta ? { type: "meta", meta } : undefined
    }
    case "item": {
      const item = parseItem(raw.item)
      return item ? { type: "item", item } : undefined
    }
    case "event": {
      const event = parseEvent(raw.event)
      return event ? { type: "event", event } : undefined
    }
    default:
      return undefined
  }
}
