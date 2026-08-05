import type { ToolDefinition } from "../providers/types"

export interface ToolResult {
  output: string
}

export interface Tool extends ToolDefinition {
  prompt?: string
  title(args: Record<string, unknown>): string
  readOnly?(args: Record<string, unknown>): boolean
  execute(args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult>
}
