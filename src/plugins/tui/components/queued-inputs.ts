import type { BoxRenderable, RenderContext } from "@opentui/core"
import type { QueuedEntry } from "../../../agent/events"
import { column, label, row } from "../lib/renderables"
import { COLORS } from "../theme/colors"

const MAX_VISIBLE = 3

function entryText(entry: QueuedEntry): string {
  const text = entry.text.replace(/\s+/g, " ").trim()
  if (entry.imageCount === 0) return text
  const images = `${entry.imageCount} image${entry.imageCount === 1 ? "" : "s"}`
  return text ? `${text} · ${images}` : images
}

export class QueuedInputs {
  readonly view: BoxRenderable
  private rows: BoxRenderable[] = []

  constructor(
    private readonly ctx: RenderContext,
    private readonly onChange: () => void,
  ) {
    this.view = column(ctx, {})
  }

  get height(): number {
    return this.rows.length === 0 ? 0 : this.rows.length + 1
  }

  set(entries: QueuedEntry[]): void {
    for (const line of this.rows) {
      this.view.remove(line)
      line.destroyRecursively()
    }
    const shown = entries.slice(0, MAX_VISIBLE)
    this.rows = shown.map((entry, index) => this.entryRow(entry, index === 0))
    if (entries.length > shown.length) this.rows.push(this.overflowRow(entries.length - shown.length))
    for (const line of this.rows) this.view.add(line)
    this.view.marginTop = this.rows.length === 0 ? 0 : 1
    this.onChange()
  }

  private entryRow(entry: QueuedEntry, first: boolean): BoxRenderable {
    const line = row(this.ctx, { height: 1, alignItems: "center" })
    line.add(label(this.ctx, { content: "↳", width: 2, color: COLORS.faint }))
    line.add(
      label(this.ctx, {
        content: entryText(entry),
        flexGrow: 1,
        flexShrink: 1,
        minWidth: 1,
        color: COLORS.faint,
      }),
    )
    if (first) {
      line.add(
        label(this.ctx, {
          content: "sent on the next step · esc to send now",
          flexShrink: 0,
          marginLeft: 2,
          color: COLORS.faint,
        }),
      )
    }
    return line
  }

  private overflowRow(hidden: number): BoxRenderable {
    const line = row(this.ctx, { height: 1, alignItems: "center" })
    line.add(label(this.ctx, { content: "", width: 2 }))
    line.add(label(this.ctx, { content: `… +${hidden} more`, color: COLORS.faint }))
    return line
  }
}
