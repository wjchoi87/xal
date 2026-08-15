import type { AgentEvent } from "../agent/events"

function normalizedLine(text: string): string | undefined {
  for (const rawLine of text.split(/\r\n|\r|\n/u)) {
    const line = rawLine
      .replace(/\p{Cc}/gu, " ")
      .replace(/\s+/gu, " ")
      .trim()
    if (line) return line
  }
  return undefined
}

export function normalizeSessionTitle(text: string): string | undefined {
  const line = normalizedLine(text)
  if (!line) return undefined
  const characters = [...line]
  return characters.length > 80 ? `${characters.slice(0, 79).join("").trimEnd()}…` : line
}

export function titleFromInput(text: string, imageCount: number): string | undefined {
  return (
    normalizeSessionTitle(text) ?? (imageCount > 0 ? (imageCount === 1 ? "Image" : `${imageCount} images`) : undefined)
  )
}

export function titleFromEvents(events: AgentEvent[]): string | undefined {
  let generated: string | undefined
  let recorded: string | undefined

  for (const event of events) {
    if (event.type === "session_title_changed") recorded = event.title
    if (event.type === "user_message" && !generated) generated = titleFromInput(event.text, event.imageCount)
    if (event.type === "shell_finished" && !generated) generated = titleFromInput(event.input, 0)
  }

  return recorded ?? generated
}
