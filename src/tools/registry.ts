import type { RegisteredTool } from "./types"

const tools = new Map<string, RegisteredTool>()

export function registerTool(tool: RegisteredTool): void {
  if (tools.has(tool.name)) throw new Error(`tool already registered: ${tool.name}`)
  tools.set(tool.name, tool)
}

export function unregisterTool(tool: RegisteredTool): void {
  if (tools.get(tool.name) === tool) tools.delete(tool.name)
}

export function getTool(name: string): RegisteredTool | undefined {
  return tools.get(name)
}

export function listTools(): RegisteredTool[] {
  return [...tools.values()]
}
