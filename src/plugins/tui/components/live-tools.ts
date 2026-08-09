import type { BoxRenderable, RenderContext, TextRenderable } from "@opentui/core"
import { formatDuration } from "../lib/format"
import { column, label, row } from "../lib/renderables"
import { Spinner } from "../lib/spinner"
import { sanitize } from "../lib/text"
import { COLORS } from "../theme/colors"
import { commandLabel, liveStatus, type LivePhase } from "./tool-status"

const TICK_MS = 100
const PREVIEW_LINES = 3
const PREVIEW_KEPT_CHARS = 4_000

interface LiveRow {
  view: BoxRenderable
  status: TextRenderable
  preview: BoxRenderable
  previewLabels: TextRenderable[]
  tail: string
  createdAt: number
  phase: LivePhase
}

export class LiveTools {
  readonly view: BoxRenderable
  private readonly rows = new Map<string, LiveRow>()
  private readonly spinner = new Spinner(TICK_MS)

  constructor(
    private readonly ctx: RenderContext,
    private readonly onChange: () => void,
  ) {
    this.view = column(ctx, {})
  }

  get height(): number {
    if (this.rows.size === 0) return 0
    let height = 1
    for (const entry of this.rows.values()) height += 1 + entry.previewLabels.length
    return height
  }

  request(callId: string, tool: string, title: string, readOnly: boolean): void {
    this.add(callId, tool, title, readOnly, "requested")
  }

  start(callId: string, tool: string, title: string, readOnly: boolean): void {
    const existing = this.rows.get(callId)
    if (existing) existing.phase = "running"
    else this.add(callId, tool, title, readOnly, "running")
    this.spinner.start(() => this.render())
    this.render()
  }

  update(callId: string, text: string): void {
    const entry = this.rows.get(callId)
    if (!entry) return
    entry.tail = (entry.tail + sanitize(text)).slice(-PREVIEW_KEPT_CHARS)
    const lines = entry.tail
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0)
      .slice(-PREVIEW_LINES)
    while (entry.previewLabels.length > lines.length) {
      const removed = entry.previewLabels.pop()!
      entry.preview.remove(removed)
      removed.destroyRecursively()
    }
    while (entry.previewLabels.length < lines.length) {
      const added = label(this.ctx, { content: "", color: COLORS.faint })
      entry.preview.add(added)
      entry.previewLabels.push(added)
    }
    lines.forEach((line, index) => {
      entry.previewLabels[index]!.content = line
    })
    this.sync()
  }

  finish(callId: string): string | undefined {
    const existing = this.rows.get(callId)
    if (!existing) return undefined
    this.rows.delete(callId)
    this.view.remove(existing.view)
    existing.view.destroyRecursively()
    if (this.rows.size === 0) this.spinner.stop()
    this.sync()
    return formatDuration(Date.now() - existing.createdAt)
  }

  clear(): void {
    if (this.rows.size === 0) return
    for (const entry of this.rows.values()) {
      this.view.remove(entry.view)
      entry.view.destroyRecursively()
    }
    this.rows.clear()
    this.spinner.stop()
    this.sync()
  }

  private add(callId: string, tool: string, title: string, readOnly: boolean, phase: LivePhase): void {
    const view = column(this.ctx, {})
    const header = row(this.ctx, { height: 1, alignItems: "center" })
    header.add(label(this.ctx, { content: readOnly ? ">" : "*", width: 2, color: COLORS.faint }))
    header.add(label(this.ctx, { content: commandLabel(tool, title), flexGrow: 1, flexShrink: 1, minWidth: 1 }))
    const status = label(this.ctx, { content: "", flexShrink: 0, marginLeft: 1 })
    header.add(status)
    view.add(header)
    const preview = column(this.ctx, { paddingLeft: 2 })
    view.add(preview)
    this.view.add(view)
    this.rows.set(callId, { view, status, preview, previewLabels: [], tail: "", createdAt: Date.now(), phase })
    this.sync()
    this.render()
  }

  private sync(): void {
    this.view.marginTop = this.rows.size === 0 ? 0 : 1
    this.onChange()
  }

  private render(): void {
    for (const entry of this.rows.values()) {
      entry.status.content = liveStatus(entry.phase, formatDuration(Date.now() - entry.createdAt), this.spinner.glyph)
    }
  }
}
