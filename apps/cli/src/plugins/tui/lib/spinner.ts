import { terminalGlyph } from "./text"

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

export class Spinner {
  private frame = 0
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(private readonly intervalMs = 110) {}

  get glyph(): string {
    return terminalGlyph(FRAMES[this.frame]!, "*")
  }

  start(onTick: () => void): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      this.frame = (this.frame + 1) % FRAMES.length
      onTick()
    }, this.intervalMs)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    this.frame = 0
  }
}
