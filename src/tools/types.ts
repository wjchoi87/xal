import type { SessionKind } from "../agent/types"
import type { PermissionMode } from "../permissions/types"
import type { PlanUpdatedEvent } from "../plans/types"
import type { ModelInputModality, Provider, ThinkingEffort, ToolDefinition } from "../providers/types"
import type { TaskListUpdatedEvent } from "../tasks/types"

export const MAX_ELICITATION_ANSWER_LENGTH = 500

export interface ToolResult {
  output: string
  events?: ToolEvent[]
}

export type ToolEvent = PlanUpdatedEvent | TaskListUpdatedEvent

export interface ElicitationOption {
  label: string
  description: string
}

export interface ElicitationQuestion {
  id: string
  header: string
  question: string
  options: ElicitationOption[]
}

export interface ElicitationRequest {
  questions: ElicitationQuestion[]
}

export interface ElicitationAnswer {
  questionId: string
  value: string
}

export type ElicitationResult = { status: "answered"; answers: ElicitationAnswer[] } | { status: "rejected" }

export interface ToolPermission {
  subject: string
  suggestion?: string
}

export type ToolConcurrency = "shared" | "exclusive"

export interface ToolAvailabilityContext {
  interactive: boolean
  kind: SessionKind
  mode: PermissionMode
}

interface ToolContract extends ToolDefinition {
  prompt?: string
  available?(ctx: ToolAvailabilityContext): boolean
  title(args: Record<string, unknown>): string
  readOnly?(args: Record<string, unknown>): boolean
  sandboxed?(args: Record<string, unknown>): boolean
  concurrency?(args: Record<string, unknown>): ToolConcurrency
  permission?(args: Record<string, unknown>): ToolPermission
}

export interface Tool extends ToolContract {
  execute(args: Record<string, unknown>, signal?: AbortSignal, update?: (text: string) => void): Promise<ToolResult>
}

export interface SessionToolContext {
  session: {
    kind: SessionKind
    cwd: string
    provider: Provider
    model: string
    modelInputModalities?: ModelInputModality[]
    thinking?: ThinkingEffort
    mode: PermissionMode
  }
  signal: AbortSignal
  update(text: string): void
}

export interface SessionTool extends ToolContract {
  sessionAware: true
  execute(args: Record<string, unknown>, ctx: SessionToolContext): Promise<ToolResult>
}

export interface InteractiveToolContext {
  session: {
    directory: string
    mode: PermissionMode
  }
  publish(event: ToolEvent): void
  requestInput(request: ElicitationRequest): Promise<ElicitationResult>
}

export interface InteractiveTool extends ToolContract {
  interactive: true
  execute(args: Record<string, unknown>, ctx: InteractiveToolContext): Promise<ToolResult>
}

export type RegisteredTool = Tool | SessionTool | InteractiveTool

export function isInteractiveTool(tool: RegisteredTool): tool is InteractiveTool {
  return "interactive" in tool && tool.interactive === true
}

export function isSessionTool(tool: RegisteredTool): tool is SessionTool {
  return "sessionAware" in tool && tool.sessionAware === true
}
