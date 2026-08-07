import type { PermissionMode } from "../permissions/types"
import type { Usage } from "../providers/types"

export type AgentState = "idle" | "streaming" | "awaiting_approval" | "running_tool"

export type DenialCause = "user" | "policy" | "plan"

export type AgentEvent =
  | { type: "session_started"; id: string; resumed: boolean; model: string; mode: PermissionMode }
  | { type: "state_changed"; state: AgentState }
  | { type: "mode_changed"; mode: PermissionMode }
  | { type: "model_changed"; provider: string; model: string }
  | { type: "user_message"; text: string; sentAt: number }
  | { type: "text_delta"; text: string }
  | { type: "reasoning_summary_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "assistant_message"; text: string }
  | { type: "reasoning_summary"; text: string }
  | { type: "approval_requested"; callId: string; tool: string; title: string; readOnly: boolean; suggestion?: string }
  | { type: "tool_started"; callId: string; tool: string; title: string; readOnly: boolean }
  | {
      type: "tool_finished"
      callId: string
      tool: string
      title: string
      readOnly: boolean
      output: string
      denial?: DenialCause
    }
  | { type: "turn_ended"; usage?: Usage }
  | { type: "turn_interrupted" }
  | { type: "error"; message: string }
