const DEFAULT_CONTEXT_WINDOW = 260_000

let cap = DEFAULT_CONTEXT_WINDOW

export function setContextWindowCap(configured: number | undefined): void {
  cap = configured ?? DEFAULT_CONTEXT_WINDOW
}

export function contextWindowCap(): number {
  return cap
}
