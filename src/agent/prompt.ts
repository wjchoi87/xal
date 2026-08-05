import type { Tool } from "../tools/types"

export interface PromptContext {
  appName: string
  platform: string
  cwd: string
  tools: Tool[]
}

export interface PromptSection {
  id: string
  text(ctx: PromptContext): string
}

const sections = new Map<string, PromptSection[]>()

export function registerPrompt(section: PromptSection): void {
  const parts = sections.get(section.id)
  if (parts) {
    parts.push(section)
    return
  }
  sections.set(section.id, [section])
}

export function registerPromptFull(section: PromptSection): void {
  sections.set(section.id, [section])
}

export function composeSystemPrompt(ctx: PromptContext): string {
  return [...sections.values()]
    .map((parts) =>
      parts
        .map((part) => part.text(ctx))
        .filter((text) => text.length > 0)
        .join("\n"),
    )
    .filter((text) => text.length > 0)
    .join("\n\n")
}
