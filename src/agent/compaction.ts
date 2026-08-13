import { resolveThinking } from "../config/thinking"
import { describeError } from "../lib/error"
import {
  profileProviderFirstEvent,
  profileProviderRequestFinished,
  profileProviderRequestStarted,
} from "../profiler/profiler"
import { findModel } from "../providers/catalog"
import { prepareConversation } from "../providers/conversation"
import type {
  ConversationItem,
  Provider,
  ProviderReplay,
  ThinkingEffort,
  Usage,
  UserMessageItem,
} from "../providers/types"
import { redactStreamRequest } from "../secrets/data"
import { redactText } from "../secrets/redactor"
import { activeHistory, conversationOnly, directShellMessage, type HistoryItem } from "./history"
import type { SessionKind } from "./types"

export const COMPACTION_TRIGGER_RATIO = 0.85

const CHARS_PER_TOKEN = 4
const IMAGE_TOKENS = 1_500
const TAIL_RATIO = 0.25
const MANUAL_TAIL_TOKENS = 16_000

export type CompactionTrigger = "auto" | "manual"

export interface CompactionTarget {
  model: string
  thinking: ThinkingEffort | undefined
}

const SUMMARY_INSTRUCTIONS = `You are compacting a coding session transcript so the assistant can keep working after the older messages are dropped.

Write a dense, factual summary that lets the assistant continue without re-reading the removed history. Cover:

1. What the user asked for, in their own terms, including every explicit instruction, constraint, and preference.
2. What has been done so far, in order: files created, read, or modified with their paths, and the shape of each change.
3. Commands that were run and what they revealed — test results, build failures, error messages worth remembering.
4. Decisions that were made and why, including approaches that were rejected.
5. The current state: what works, what is broken, what is half-finished.
6. What comes next: the immediate task and any user request that has not been answered yet.

Rules:
- Preserve exact identifiers: file paths, function and symbol names, command lines, error strings, and versions.
- Do not invent anything that is not in the transcript, and do not soften or drop bad news.
- Omit pleasantries and narration; write for a reader who must resume work immediately.
- Output the summary only, with no preamble.`

export function tailBudget(window: number | undefined, trigger: CompactionTrigger): number {
  if (window === undefined) return MANUAL_TAIL_TOKENS
  const budget = Math.floor(window * TAIL_RATIO)
  return trigger === "manual" ? Math.min(budget, MANUAL_TAIL_TOKENS) : budget
}

export async function resolveCompactionTarget(provider: Provider, model: string): Promise<CompactionTarget> {
  const fastModel = model.endsWith("-fast") ? model : `${model}-fast`
  const requestModel = fastModel === model || (await findModel(provider, fastModel)) ? fastModel : model
  return { model: requestModel, thinking: await resolveThinking(provider, requestModel, "low") }
}

function textTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

function replayTokens(replay: ProviderReplay | undefined): number {
  return replay ? textTokens(JSON.stringify(replay.data)) : 0
}

function itemTokens(item: HistoryItem): number {
  switch (item.type) {
    case "user_message":
      return textTokens(item.modelText ?? item.text) + item.images.length * IMAGE_TOKENS
    case "assistant_message":
      return Math.max(textTokens(item.text), replayTokens(item.replay))
    case "reasoning":
      return Math.max(textTokens(item.summary), replayTokens(item.replay))
    case "tool_call":
      return Math.max(textTokens(item.name) + textTokens(JSON.stringify(item.args)), replayTokens(item.replay))
    case "tool_result":
      return textTokens(item.output)
    case "direct_shell":
      return itemTokens(directShellMessage(item))
    case "compaction":
      return item.retained.reduce((total, retained) => total + itemTokens(retained), textTokens(item.summary))
  }
}

export function estimateHistoryTokens(items: HistoryItem[]): number {
  return items.reduce((total, item) => total + itemTokens(item), 0)
}

export interface CompactionSplit {
  head: HistoryItem[]
  tail: ConversationItem[]
  replaced: number
}

function startsRound(items: HistoryItem[], index: number): boolean {
  const item = items[index]!
  if (item.type === "tool_result") return false
  if (item.type === "user_message" || item.type === "direct_shell") return true
  const previous = items[index - 1]
  if (!previous) return true
  return (
    previous.type === "user_message" ||
    previous.type === "tool_result" ||
    previous.type === "direct_shell" ||
    previous.type === "compaction"
  )
}

function tailStart(items: HistoryItem[], boundary: number): number {
  for (let index = boundary; index < items.length; index++) {
    if (startsRound(items, index)) return index
  }
  return items.length
}

export function splitForCompaction(items: HistoryItem[], tailTokens: number): CompactionSplit {
  const floor = items.findLastIndex((item) => item.type === "compaction") + 1
  let boundary = items.length
  let tokens = 0

  while (boundary > floor) {
    const next = tokens + itemTokens(items[boundary - 1]!)
    if (next > tailTokens) break
    tokens = next
    boundary -= 1
  }

  if (boundary <= floor) return { head: [], tail: [], replaced: 0 }
  const start = tailStart(items, boundary)
  return { head: items.slice(0, start), tail: conversationOnly(items.slice(start)), replaced: start - floor }
}

export interface SummaryRequest {
  provider: Provider
  model: string
  historyModel?: string
  thinking: ThinkingEffort | undefined
  sessionId: string
  kind?: SessionKind
  history: HistoryItem[]
  instructions: string | undefined
  signal: AbortSignal
}

function summaryRequest(instructions: string | undefined): UserMessageItem {
  const focus = instructions ? `\n\nFocus the summary on: ${instructions}` : ""
  return {
    type: "user_message",
    text: `Summarize the conversation above so that work can continue after the earlier messages are dropped.${focus}`,
    images: [],
  }
}

export async function summarizeHistory(request: SummaryRequest): Promise<string> {
  const target = { provider: request.provider.id, model: request.historyModel ?? request.model }
  const input = prepareConversation([...activeHistory(request.history), summaryRequest(request.instructions)], target)
  const profile = profileProviderRequestStarted(
    request.sessionId,
    request.kind ?? "primary",
    "compaction",
    request.provider.id,
    request.model,
    request.thinking,
    1,
  )

  let streamed = ""
  let settled = ""
  let received = false
  let usage: Usage | undefined
  try {
    for await (const event of request.provider.stream(
      redactStreamRequest({
        model: request.model,
        ...(request.historyModel === undefined ? {} : { conversationModel: request.historyModel }),
        thinking: request.thinking,
        instructions: SUMMARY_INSTRUCTIONS,
        input,
        tools: [],
        sessionId: request.sessionId,
        signal: request.signal,
      }),
    )) {
      if (!received) {
        received = true
        profileProviderFirstEvent(profile, event.type)
      }
      if (event.type === "text_delta") streamed += event.text
      if (event.type === "item_done" && event.item.type === "assistant_message") settled += event.item.text
      if (event.type === "done") usage = event.usage
    }

    const summary = (settled || streamed).trim()
    if (!summary) throw new Error(`${request.provider.name} returned an empty summary`)
    profileProviderRequestFinished(profile, "completed", usage)
    return redactText(summary)
  } catch (error) {
    profileProviderRequestFinished(
      profile,
      request.signal.aborted || (error instanceof Error && error.name === "AbortError") ? "interrupted" : "failed",
      usage,
      describeError(error),
    )
    throw error
  }
}
