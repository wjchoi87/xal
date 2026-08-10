import type { PermissionMode } from "../permissions/types"
import type { ThinkingEffort, Usage, UserInput } from "../providers/types"
import type { ElicitationQuestion } from "../tools/types"
import type { ToolEvent } from "../tools/types"

export type AgentState = "idle" | "streaming" | "awaiting_approval" | "awaiting_input" | "running_tool" | "compacting"

export type DenialCause = "user" | "policy" | "plan"

export interface QueuedEntry {
  text: string
  imageCount: number
}

export interface SessionStartedEvent {
  type: "session_started"
  id: string
  resumed: boolean
  provider: string
  model: string
  thinking?: ThinkingEffort
  mode: PermissionMode
}

export type AgentEvent =
  | ToolEvent
  | SessionStartedEvent
  | { type: "state_changed"; state: AgentState }
  | { type: "mode_changed"; mode: PermissionMode }
  | { type: "model_changed"; provider: string; model: string }
  | { type: "thinking_changed"; thinking?: ThinkingEffort }
  | { type: "user_message"; text: string; imageCount: number; sentAt: number }
  | { type: "queue_changed"; entries: QueuedEntry[] }
  | { type: "queue_flushed"; inputs: UserInput[] }
  | { type: "text_delta"; text: string }
  | { type: "reasoning_summary_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "assistant_message"; text: string }
  | { type: "reasoning_summary"; text: string }
  | { type: "retry_scheduled"; attempt: number; maxAttempts: number; delayMs: number; message: string }
  | { type: "approval_requested"; callId: string; tool: string; title: string; readOnly: boolean; suggestion?: string }
  | { type: "elicitation_requested"; requestId: string; callId: string; questions: ElicitationQuestion[] }
  | { type: "elicitation_resolved"; callId: string }
  | { type: "tool_started"; callId: string; tool: string; title: string; readOnly: boolean }
  | { type: "tool_updated"; callId: string; text: string }
  | {
      type: "tool_finished"
      callId: string
      tool: string
      title: string
      readOnly: boolean
      output: string
      denial?: DenialCause
    }
  | { type: "compacted"; summary: string; replaced: number; tokensBefore?: number }
  | { type: "turn_ended"; usage?: Usage; context?: Usage }
  | { type: "turn_failed"; message: string }
  | { type: "turn_interrupted" }
  | { type: "error"; message: string }
