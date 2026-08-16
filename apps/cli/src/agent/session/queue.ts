import type { UserInput } from "../../providers/types"
import type { AgentEvent } from "../events"

export function directShellCommand(input: UserInput): string | undefined {
  if (input.images.length > 0) return undefined
  const text = input.text.trimStart()
  return text.startsWith("!") ? text.slice(1).trim() : undefined
}

export function isDirectShellInput(input: UserInput): boolean {
  return directShellCommand(input) !== undefined
}

export function interjectionMessage(text: string): string {
  return [
    "<system-notice>",
    "This message arrived while you were working. The request you were already working on is still in progress.",
    "Handle this message, then continue that work in the same turn. Answering a question or reporting status does not complete the turn.",
    "Stop only when the earlier request is finished, this message replaces it, or it asks you to stop.",
    "</system-notice>",
    "<message>",
    text,
    "</message>",
  ].join("\n")
}

export function interjectionResumeMessage(): string {
  return [
    "<system-notice>",
    "Your last response handled the message that arrived while you were working, but did not carry the earlier request any further.",
    "If that request is unfinished, continue it now. If it is already complete or the new message replaced it, say so in one line and stop.",
    "</system-notice>",
  ].join("\n")
}

export class InputQueue {
  private queued: UserInput[] = []

  constructor(private readonly emit: (event: AgentEvent) => void) {}

  get first(): UserInput | undefined {
    return this.queued[0]
  }

  get promptFirst(): boolean {
    return this.queued[0] !== undefined && !isDirectShellInput(this.queued[0])
  }

  push(input: UserInput): void {
    this.queued.push(input)
    this.changed()
  }

  restore(inputs: UserInput[]): void {
    if (inputs.length === 0) return
    this.queued.unshift(...inputs)
    this.changed()
  }

  takeDirectShell(): UserInput | undefined {
    const first = this.queued[0]
    if (!first || !isDirectShellInput(first)) return undefined
    this.queued.shift()
    this.changed()
    return first
  }

  takePrompts(): UserInput[] {
    const boundary = this.queued.findIndex(isDirectShellInput)
    const inputs = this.queued.splice(0, boundary < 0 ? this.queued.length : boundary)
    if (inputs.length > 0) this.changed()
    return inputs
  }

  flush(): void {
    if (this.queued.length === 0) return
    const inputs = this.queued.splice(0)
    this.emit({ type: "queue_changed", entries: [] })
    this.emit({ type: "queue_flushed", inputs })
  }

  private changed(): void {
    this.emit({
      type: "queue_changed",
      entries: this.queued.map((input) => ({ text: input.text, imageCount: input.images.length })),
    })
  }
}
