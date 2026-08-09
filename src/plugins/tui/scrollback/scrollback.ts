import type { CliRenderer, ScrollbackSurface, TextRenderable } from "@opentui/core"
import type { Block, StreamBlock, StreamKind } from "./blocks"
import { contentWidth, renderBlock, streamContent, streamView } from "./render"

const FLUSH_MS = 50

interface Stream {
  block: StreamBlock
  surface: ScrollbackSurface
  text: TextRenderable
  committed: number
  flushedAt: number
}

export class Scrollback {
  private readonly blocks: Block[] = []
  private stream: Stream | undefined
  private expanded = false
  private committed = 0
  private origin: number

  constructor(
    private readonly renderer: CliRenderer,
    startRow: number,
    private readonly onCommit: (rows: number) => void,
  ) {
    this.origin = startRow
  }

  get rows(): number {
    return this.origin + this.committed
  }

  append(block: Block): void {
    this.endStream()
    const previous = this.blocks[this.blocks.length - 1]
    this.blocks.push(block)
    this.emit(block, previous)
  }

  appendStream(kind: StreamKind, delta: string): void {
    if (this.stream && this.stream.block.kind !== kind) this.endStream()
    const stream = this.stream ?? this.beginStream(kind)
    stream.block.text += delta
    const now = Date.now()
    if (now - stream.flushedAt < FLUSH_MS) return
    stream.flushedAt = now
    this.flush(stream, false)
  }

  endStream(): boolean {
    const stream = this.stream
    if (!stream) return false
    this.stream = undefined
    const flushed = stream.block.text.length > 0
    if (flushed) this.flush(stream, true)
    else this.drop(stream.block)
    stream.surface.destroy()
    return flushed
  }

  clear(): void {
    this.endStream()
    this.blocks.length = 0
    this.reset()
    this.renderer.resetSplitFooterForReplay({ clearSavedLines: true })
  }

  toggleExpanded(): void {
    this.expanded = !this.expanded
    this.replay()
  }

  replay(): void {
    const streaming = this.stream
    if (streaming) {
      streaming.surface.destroy()
      this.stream = undefined
    }
    this.renderer.resetSplitFooterForReplay({ clearSavedLines: true })
    this.reset()
    let previous: Block | undefined
    for (const block of this.blocks) {
      if (block === streaming?.block) continue
      this.emit(block, previous)
      previous = block
    }
    if (!streaming) return
    this.stream = this.openStream(streaming.block)
    this.flush(this.stream, false)
  }

  private reset(): void {
    this.origin = 0
    this.committed = 0
  }

  private liveRows(): number {
    return Math.max(1, this.renderer.terminalHeight - this.renderer.footerHeight - 1)
  }

  private drop(block: Block): void {
    const index = this.blocks.indexOf(block)
    if (index < 0) return
    this.blocks.splice(index, 1)
  }

  private beginStream(kind: StreamKind): Stream {
    const block: StreamBlock = { kind, text: "" }
    this.blocks.push(block)
    this.stream = this.openStream(block)
    return this.stream
  }

  private openStream(block: StreamBlock): Stream {
    const surface = this.renderer.createScrollbackSurface()
    const { view, text } = streamView(surface.renderContext, block)
    surface.root.add(view)
    return { block, surface, text, committed: 0, flushedAt: 0 }
  }

  private flush(stream: Stream, final: boolean): void {
    const rendered = streamContent(stream.block, contentWidth(stream.surface.renderContext))
    stream.text.content = rendered.content
    stream.text.height = rendered.rows
    stream.surface.render()
    const pending = rendered.rows - rendered.stable
    const held = final ? 0 : rendered.flowing ? Math.max(1, Math.min(pending, this.liveRows())) : pending
    const target = stream.surface.height - held
    if (target <= stream.committed) return
    const rows = target - stream.committed
    this.onCommit(rows)
    stream.surface.commitRows(stream.committed, target)
    this.committed += rows
    stream.committed = target
  }

  private emit(block: Block, previous: Block | undefined): void {
    const surface = this.renderer.createScrollbackSurface()
    try {
      surface.root.add(renderBlock(surface.renderContext, block, this.expanded, previous))
      surface.render()
      this.onCommit(surface.height)
      surface.commitRows(0, surface.height)
      this.committed += surface.height
    } finally {
      surface.destroy()
    }
  }
}
