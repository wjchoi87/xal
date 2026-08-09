import type { ConversationItem, UserMessageItem } from "../providers/types"

export interface CompactionItem {
  type: "compaction"
  summary: string
  replaced: number
  tokensBefore?: number
  retained: ConversationItem[]
}

export type HistoryItem = ConversationItem | CompactionItem

const SUMMARY_PREAMBLE =
  "The earlier part of this conversation was summarized to free context. Treat the summary below as the authoritative record of everything that happened before the messages that follow."

export function summaryMessage(summary: string): UserMessageItem {
  return {
    type: "user_message",
    text: `${SUMMARY_PREAMBLE}\n\n<conversation-summary>\n${summary}\n</conversation-summary>`,
    images: [],
  }
}

export function conversationOnly(items: HistoryItem[]): ConversationItem[] {
  return items.flatMap((item) => (item.type === "compaction" ? [] : [item]))
}

export function activeHistory(items: HistoryItem[]): ConversationItem[] {
  const active: ConversationItem[] = []
  for (const item of items) {
    if (item.type === "compaction") {
      active.length = 0
      active.push(summaryMessage(item.summary), ...item.retained)
      continue
    }
    active.push(item)
  }
  return active
}
