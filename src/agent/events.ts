import type { Usage } from "../providers/types"

export type AgentState = "idle" | "streaming" | "awaiting_approval" | "running_tool"

export type AgentEvent =
  | { type: "state_changed"; state: AgentState }
  | { type: "user_message"; text: string; sentAt: number }
  | { type: "text_delta"; text: string }
  | { type: "reasoning_summary_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "approval_requested"; callId: string; tool: string; title: string; readOnly: boolean }
  | { type: "tool_started"; callId: string; tool: string; title: string; readOnly: boolean }
  | { type: "tool_finished"; callId: string; tool: string; title: string; output: string; denied: boolean }
  | { type: "turn_ended"; usage?: Usage }
  | { type: "turn_interrupted" }
  | { type: "error"; message: string }
