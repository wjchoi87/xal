import { terminalGlyph } from "./text"

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
const TICK_MS = 80

const listeners = new Set<() => void>()
let timer: ReturnType<typeof setInterval> | undefined

export function spinnerGlyph(): string {
  return terminalGlyph(FRAMES[Math.floor(Date.now() / TICK_MS) % FRAMES.length]!, "*")
}

function subscribe(onTick: () => void): () => void {
  listeners.add(onTick)
  if (!timer) {
    timer = setInterval(() => {
      for (const listener of listeners) listener()
    }, TICK_MS)
    timer.unref()
  }
  return () => {
    listeners.delete(onTick)
    if (listeners.size === 0 && timer) {
      clearInterval(timer)
      timer = undefined
    }
  }
}

export interface SpinnerHandle {
  start(): void
  stop(): void
}

export function spinnerHandle(onTick: () => void): SpinnerHandle {
  let unsubscribe: (() => void) | undefined
  return {
    start() {
      unsubscribe ??= subscribe(onTick)
    },
    stop() {
      unsubscribe?.()
      unsubscribe = undefined
    },
  }
}
