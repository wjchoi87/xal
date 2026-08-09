import type { ToolDefinition } from "../providers/types"

export const MAX_ELICITATION_ANSWER_LENGTH = 500

export interface ToolResult {
  output: string
}

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

interface ToolContract extends ToolDefinition {
  prompt?: string
  title(args: Record<string, unknown>): string
  readOnly?(args: Record<string, unknown>): boolean
  sandboxed?(args: Record<string, unknown>): boolean
  permission?(args: Record<string, unknown>): ToolPermission
}

export interface Tool extends ToolContract {
  execute(args: Record<string, unknown>, signal?: AbortSignal, update?: (text: string) => void): Promise<ToolResult>
}

export interface InteractiveToolContext {
  requestInput(request: ElicitationRequest): Promise<ElicitationResult>
}

export interface InteractiveTool extends ToolContract {
  interactive: true
  execute(args: Record<string, unknown>, ctx: InteractiveToolContext): Promise<ToolResult>
}

export type RegisteredTool = Tool | InteractiveTool

export function isInteractiveTool(tool: RegisteredTool): tool is InteractiveTool {
  return "interactive" in tool && tool.interactive === true
}
