import { resolveRenderLib, type CliRenderer } from "@opentui/core"

export class TerminalOutput {
  private destroyed = false
  private readonly pending: string[] = []
  private requested = false
  private readonly writeFrame = async (): Promise<void> => {
    if (this.pending.length === 0) return
    try {
      const sequence = this.pending.splice(0).join("")
      this.emit(sequence)
    } finally {
      if (this.requested) {
        this.requested = false
        this.renderer.dropLive()
      }
    }
  }

  constructor(
    private readonly renderer: CliRenderer,
    private readonly writeDirect: (sequence: string) => void,
  ) {
    renderer.setFrameCallback(this.writeFrame)
  }

  write(sequence: string): void {
    if (this.destroyed || !sequence) return
    this.pending.push(sequence)
    if (this.requested) return
    this.requested = true
    this.renderer.requestLive()
  }

  destroy(): void {
    if (this.destroyed) return
    this.renderer.removeFrameCallback(this.writeFrame)
    if (this.pending.length > 0) {
      this.emit(this.pending.splice(0).join(""))
    }
    if (this.requested) {
      this.requested = false
      this.renderer.dropLive()
    }
    this.destroyed = true
  }

  private emit(sequence: string): void {
    if (!this.renderer.useThread) {
      this.writeDirect(sequence)
      return
    }
    resolveRenderLib().writeOut(this.renderer.rendererPtr, sequence)
  }
}
