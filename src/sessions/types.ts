import type { AgentEvent } from "../agent/events"
import type { PermissionMode } from "../permissions/types"
import type { ConversationItem, ThinkingEffort } from "../providers/types"

export interface SessionMeta {
  version: 1
  id: string
  cwd: string
  provider: string
  model: string
  thinking?: ThinkingEffort
  mode: PermissionMode
  startedAt: number
}

export type SessionRecord =
  { type: "meta"; meta: SessionMeta } | { type: "item"; item: ConversationItem } | { type: "event"; event: AgentEvent }

export interface SessionSummary {
  id: string
  path: string
  cwd: string
  title: string
  messages: number
  updatedAt: number
}

export interface LoadedSession {
  meta: SessionMeta
  items: ConversationItem[]
  events: AgentEvent[]
}
