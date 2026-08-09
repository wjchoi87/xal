import type { RegisteredTool } from "./types"

const tools = new Map<string, RegisteredTool>()

export function registerTool(tool: RegisteredTool): void {
  tools.set(tool.name, tool)
}

export function getTool(name: string): RegisteredTool | undefined {
  return tools.get(name)
}

export function listTools(): RegisteredTool[] {
  return [...tools.values()]
}
