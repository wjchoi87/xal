import type { BoxRenderable, RenderContext, TextRenderable } from "@opentui/core"
import { formatDuration } from "../lib/format"
import { column, label, row } from "../lib/renderables"
import { Spinner } from "../lib/spinner"
import { COLORS } from "../theme/colors"
import { commandLabel, liveStatus, type LivePhase } from "./tool-status"

const TICK_MS = 100

interface LiveRow {
  view: BoxRenderable
  status: TextRenderable
  createdAt: number
  readOnly: boolean
  phase: LivePhase
}

export interface FinishedTool {
  readOnly: boolean
  elapsed: string
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
    return this.rows.size === 0 ? 0 : this.rows.size + 1
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

  finish(callId: string): FinishedTool | undefined {
    const existing = this.rows.get(callId)
    if (!existing) return undefined
    this.rows.delete(callId)
    this.view.remove(existing.view)
    existing.view.destroyRecursively()
    if (this.rows.size === 0) this.spinner.stop()
    this.sync()
    return { readOnly: existing.readOnly, elapsed: formatDuration(Date.now() - existing.createdAt) }
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
    const view = row(this.ctx, { height: 1, alignItems: "center" })
    view.add(label(this.ctx, { content: readOnly ? ">" : "*", width: 2, color: COLORS.faint }))
    view.add(label(this.ctx, { content: commandLabel(tool, title), flexGrow: 1, flexShrink: 1, minWidth: 1 }))
    const status = label(this.ctx, { content: "", flexShrink: 0, marginLeft: 1 })
    view.add(status)
    this.view.add(view)
    this.rows.set(callId, { view, status, createdAt: Date.now(), readOnly, phase })
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
