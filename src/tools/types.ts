import type { ToolDefinition } from "../providers/types"

export interface ToolResult {
  output: string
}

export interface ToolPermission {
  subject: string
  suggestion?: string
}

export interface Tool extends ToolDefinition {
  prompt?: string
  title(args: Record<string, unknown>): string
  readOnly?(args: Record<string, unknown>): boolean
  sandboxed?(args: Record<string, unknown>): boolean
  permission?(args: Record<string, unknown>): ToolPermission
  execute(args: Record<string, unknown>, signal?: AbortSignal, update?: (text: string) => void): Promise<ToolResult>
}
