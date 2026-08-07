import type { AgentEvent, DenialCause } from "../agent/events"
import { asBoolean, asNumber, asString, isRecord } from "../lib/json"
import { isPermissionMode } from "../permissions/types"
import type { Usage } from "../providers/types"
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
  return { inputTokens: asNumber(value.inputTokens), outputTokens: asNumber(value.outputTokens) }
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
      return { type: "turn_ended", usage: parseUsage(raw.usage) }
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
  const id = asString(raw.id)
  const cwd = asString(raw.cwd)
  const provider = asString(raw.provider)
  const model = asString(raw.model)
  const mode = asString(raw.mode)
  if (!id || !cwd || !provider || !model || !mode || !isPermissionMode(mode)) return undefined
  return { id, cwd, provider, model, mode, startedAt: asNumber(raw.startedAt) ?? 0 }
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
    case "item":
      return isRecord(raw.item) ? { type: "item", item: raw.item } : undefined
    case "event": {
      const event = parseEvent(raw.event)
      return event ? { type: "event", event } : undefined
    }
    default:
      return undefined
  }
}
