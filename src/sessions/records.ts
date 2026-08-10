import type { AgentEvent, DenialCause } from "../agent/events"
import type { CompactionItem, HistoryItem } from "../agent/history"
import type { HookAction, HookEvent } from "../hooks/types"
import { asBoolean, asNumber, asString, isJsonObject, isRecord } from "../lib/json"
import { isPermissionMode } from "../permissions/types"
import { parseSessionPlan } from "../plans/types"
import {
  isThinkingEffort,
  type ConversationItem,
  type ImageInput,
  type ProviderReplay,
  type ThinkingEffort,
  type Usage,
} from "../providers/types"
import { parseTaskList } from "../tasks/types"
import { normalizeSessionTitle } from "./title"
import type { SessionMeta, SessionRecord } from "./types"

export function isPersistable(event: AgentEvent): boolean {
  return parseEvent(event) !== undefined
}

function parseDenial(value: unknown): DenialCause | undefined {
  const denial = asString(value)
  if (denial === "user" || denial === "policy" || denial === "plan" || denial === "hook") return denial
  return undefined
}

function parseHookEvent(value: unknown): HookEvent | undefined {
  const event = asString(value)
  if (event === "prompt" || event === "before_tool" || event === "after_tool" || event === "turn_end") return event
  return undefined
}

function parseHookAction(value: unknown): HookAction | undefined {
  const action = asString(value)
  if (
    action === "continued" ||
    action === "modified" ||
    action === "blocked" ||
    action === "failed" ||
    action === "interrupted"
  ) {
    return action
  }
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

function parseThinking(value: unknown): ThinkingEffort | undefined {
  return isThinkingEffort(value) ? value : undefined
}

function parseEvent(raw: unknown): AgentEvent | undefined {
  if (!isRecord(raw)) return undefined

  switch (asString(raw.type)) {
    case "session_title_changed": {
      const title = asString(raw.title)
      if (!title || normalizeSessionTitle(title) !== title) return undefined
      return { type: "session_title_changed", title }
    }
    case "workspace_changed": {
      const cwd = asString(raw.cwd)
      const previous = asString(raw.previous)
      if (!cwd || !previous) return undefined
      return { type: "workspace_changed", cwd, previous }
    }
    case "task_list_updated": {
      const tasks = parseTaskList(raw.tasks)
      if (!tasks) return undefined
      return { type: "task_list_updated", tasks }
    }
    case "plan_updated": {
      const plan = parseSessionPlan(raw.plan)
      return plan ? { type: "plan_updated", plan } : undefined
    }
    case "user_message": {
      const text = asString(raw.text)
      if (text === undefined) return undefined
      return {
        type: "user_message",
        text,
        imageCount: asNumber(raw.imageCount) ?? 0,
        sentAt: asNumber(raw.sentAt) ?? 0,
      }
    }
    case "hook_finished": {
      const hook = asString(raw.hook)
      const event = parseHookEvent(raw.event)
      const action = parseHookAction(raw.action)
      const elapsedMs = asNumber(raw.elapsedMs)
      if (!hook || !event || !action || elapsedMs === undefined) return undefined
      return { type: "hook_finished", hook, event, action, elapsedMs }
    }
    case "tool_call_updated": {
      const callId = asString(raw.callId)
      const tool = asString(raw.tool)
      if (!callId || !tool || !isJsonObject(raw.args)) return undefined
      return { type: "tool_call_updated", callId, tool, args: raw.args }
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
    case "compacted": {
      const summary = asString(raw.summary)
      const replaced = asNumber(raw.replaced)
      if (!summary || replaced === undefined) return undefined
      return { type: "compacted", summary, replaced, tokensBefore: asNumber(raw.tokensBefore) }
    }
    case "turn_ended": {
      if (raw.output !== undefined && !isJsonObject(raw.output)) return undefined
      return {
        type: "turn_ended",
        usage: parseUsage(raw.usage),
        context: parseUsage(raw.context),
        output: raw.output,
      }
    }
    case "turn_failed": {
      const message = asString(raw.message)
      if (message === undefined) return undefined
      return { type: "turn_failed", message }
    }
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
    case "thinking_changed":
      return { type: "thinking_changed", thinking: parseThinking(raw.thinking) }
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
  return {
    version: 1,
    id,
    cwd,
    provider,
    model,
    thinking: parseThinking(raw.thinking),
    mode,
    startedAt: asNumber(raw.startedAt) ?? 0,
  }
}

function parseReplay(raw: unknown): ProviderReplay | undefined {
  if (!isRecord(raw)) return undefined
  const provider = asString(raw.provider)
  if (!provider || !isJsonObject(raw.data)) return undefined
  if (raw.model === undefined) return { provider, data: raw.data }
  const model = asString(raw.model)
  return model ? { provider, model, data: raw.data } : undefined
}

function parseOptionalReplay(raw: Record<string, unknown>): { replay?: ProviderReplay } | undefined {
  if (raw.replay === undefined) return {}
  const replay = parseReplay(raw.replay)
  return replay ? { replay } : undefined
}

function parseImage(raw: unknown): ImageInput | undefined {
  if (!isRecord(raw)) return undefined
  const mediaType = asString(raw.mediaType)
  const data = asString(raw.data)
  if ((mediaType !== "image/png" && mediaType !== "image/jpeg") || !data) return undefined
  if (data.length % 4 !== 0 || !/^[a-zA-Z0-9+/]+={0,2}$/.test(data)) return undefined
  return { mediaType, data }
}

function parseImages(raw: unknown): ImageInput[] | undefined {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) return undefined
  const images = raw.flatMap((image) => {
    const parsed = parseImage(image)
    return parsed ? [parsed] : []
  })
  return images.length === raw.length ? images : undefined
}

function parseConversationItem(raw: unknown): ConversationItem | undefined {
  if (!isRecord(raw)) return undefined

  switch (asString(raw.type)) {
    case "user_message": {
      const text = asString(raw.text)
      const images = parseImages(raw.images)
      if (text === undefined || !images) return undefined
      if (raw.modelText === undefined) return { type: "user_message", text, images }
      const modelText = asString(raw.modelText)
      return modelText === undefined ? undefined : { type: "user_message", text, images, modelText }
    }
    case "assistant_message": {
      const text = asString(raw.text)
      const replay = parseOptionalReplay(raw)
      if (text === undefined || !replay) return undefined
      return { type: "assistant_message", text, ...replay }
    }
    case "reasoning": {
      const summary = asString(raw.summary)
      const replay = parseOptionalReplay(raw)
      if (summary === undefined || !replay) return undefined
      return { type: "reasoning", summary, ...replay }
    }
    case "tool_call": {
      const callId = asString(raw.callId)
      const name = asString(raw.name)
      const replay = parseOptionalReplay(raw)
      if (!callId || !name || !isJsonObject(raw.args) || !replay) return undefined
      return { type: "tool_call", callId, name, args: raw.args, ...replay }
    }
    case "tool_result": {
      const callId = asString(raw.callId)
      const output = asString(raw.output)
      if (!callId || output === undefined) return undefined
      return { type: "tool_result", callId, output }
    }
    default:
      return undefined
  }
}

function parseCompaction(raw: Record<string, unknown>): CompactionItem | undefined {
  const summary = asString(raw.summary)
  const replaced = asNumber(raw.replaced)
  if (!summary || replaced === undefined || !Array.isArray(raw.retained)) return undefined
  const retained = raw.retained.flatMap((entry) => {
    const item = parseConversationItem(entry)
    return item ? [item] : []
  })
  return { type: "compaction", summary, replaced, tokensBefore: asNumber(raw.tokensBefore), retained }
}

function parseItem(raw: unknown): HistoryItem | undefined {
  if (isRecord(raw) && asString(raw.type) === "compaction") return parseCompaction(raw)
  return parseConversationItem(raw)
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
