import {
  RenderableEvents,
  StyledText,
  type BoxRenderable,
  type RenderContext,
  type TextRenderable,
} from "@opentui/core"
import {
  listBackgroundTasks,
  removeBackgroundTask,
  subscribeBackgroundTasks,
  type BackgroundTask,
} from "../../../background/registry"
import { describeError } from "../../../lib/error"
import { formatDuration } from "../lib/format"
import { column, detailPanel, label, row } from "../lib/renderables"
import { Spinner } from "../lib/spinner"
import { firstLine, sanitize, terminalGlyph } from "../lib/text"
import { COLORS } from "../theme/colors"
import { muted, paint } from "../theme/styles"

const TICK_MS = 100
const MAX_VISIBLE = 4
const PREVIEW_LINES = 8
const PREVIEW_KEPT_CHARS = 4_000
const GUTTER = 4

export interface BackgroundTasksActions {
  changed(): void
  released(): void
  error(message: string): void
}

interface TaskRow {
  task: BackgroundTask
  view: BoxRenderable
  cursor: TextRenderable
  glyph: TextRenderable
  text: TextRenderable
  status: TextRenderable
  discover: TextRenderable
  preview: BoxRenderable
  previewLabels: TextRenderable[]
}

export class BackgroundTasks {
  readonly view: BoxRenderable
  private readonly overflow: BoxRenderable
  private readonly overflowText: TextRenderable
  private readonly hints: BoxRenderable
  private readonly hintText: TextRenderable
  private rows: TaskRow[] = []
  private readonly spinner = new Spinner(TICK_MS)
  private focusedFlag = false
  private selected = 0
  private offset = 0
  private expanded = false

  constructor(
    private readonly ctx: RenderContext,
    private readonly actions: BackgroundTasksActions,
  ) {
    this.view = column(ctx, { paddingLeft: 2, paddingRight: 2 })
    this.overflow = row(this.ctx, { height: 1, visible: false })
    this.overflow.add(label(this.ctx, { content: "", width: GUTTER }))
    this.overflowText = label(this.ctx, { content: "", color: COLORS.faint })
    this.overflow.add(this.overflowText)
    this.hints = row(this.ctx, { height: 1, visible: false })
    this.hints.add(label(this.ctx, { content: "", width: GUTTER }))
    this.hintText = label(this.ctx, { content: "", color: COLORS.faint })
    this.hints.add(this.hintText)
    this.view.add(this.overflow)
    this.view.add(this.hints)
    const unsubscribe = subscribeBackgroundTasks(() => this.sync())
    this.view.on(RenderableEvents.DESTROYED, () => {
      unsubscribe()
      this.spinner.stop()
    })
  }

  get height(): number {
    if (this.rows.length === 0) return 0
    const visible = Math.min(this.rows.length, MAX_VISIBLE)
    const overflow = this.rows.length > MAX_VISIBLE ? 1 : 0
    const hints = this.focusedFlag ? 1 : 0
    const preview = this.expanded ? (this.rows[this.selected]?.previewLabels.length ?? 0) : 0
    return 1 + visible + overflow + hints + preview
  }

  get count(): number {
    return this.rows.length
  }

  get focused(): boolean {
    return this.focusedFlag
  }

  focus(): void {
    if (this.rows.length === 0 || this.focusedFlag) return
    this.focusedFlag = true
    this.render()
  }

  blur(): void {
    if (!this.focusedFlag) return
    this.focusedFlag = false
    this.expanded = false
    this.render()
  }

  handleKey(name: string): boolean {
    if (!this.focusedFlag || this.rows.length === 0) return false
    if (name === "up" || name === "down") {
      const count = this.rows.length
      this.selected = (this.selected + (name === "up" ? -1 : 1) + count) % count
      this.render()
      return true
    }
    if (name === "return" || name === "enter") {
      this.expanded = !this.expanded
      this.render()
      return true
    }
    if (name === "k") {
      const entry = this.rows[this.selected]
      if (!entry) return true
      if (entry.task.state().running) {
        entry.task.stop().catch((error: unknown) => this.actions.error(describeError(error)))
      } else {
        this.expanded = false
        removeBackgroundTask(entry.task.id)
      }
      return true
    }
    if (name === "escape") {
      if (this.expanded) {
        this.expanded = false
        this.render()
        return true
      }
      this.blur()
      this.actions.released()
      return true
    }
    return false
  }

  private sync(): void {
    const tasks = listBackgroundTasks()
    if (tasks.length !== this.rows.length || tasks.some((task, index) => task.id !== this.rows[index]!.task.id)) {
      this.rebuild(tasks)
    }
    if (tasks.length === 0 && this.focusedFlag) {
      this.blur()
      this.actions.released()
    }
    if (tasks.some((task) => task.state().running)) this.spinner.start(() => this.render())
    else this.spinner.stop()
    this.render()
    this.actions.changed()
  }

  private rebuild(tasks: BackgroundTask[]): void {
    const selectedId = this.rows[this.selected]?.task.id
    for (const entry of this.rows) {
      this.view.remove(entry.view)
      entry.view.destroyRecursively()
    }
    this.view.remove(this.overflow)
    this.view.remove(this.hints)
    this.rows = tasks.map((task) => this.taskRow(task))
    for (const entry of this.rows) this.view.add(entry.view)
    this.view.add(this.overflow)
    this.view.add(this.hints)
    const kept = this.rows.findIndex((entry) => entry.task.id === selectedId)
    this.selected = kept >= 0 ? kept : Math.min(this.selected, Math.max(0, this.rows.length - 1))
    this.view.marginTop = this.rows.length === 0 ? 0 : 1
  }

  private taskRow(task: BackgroundTask): TaskRow {
    const view = column(this.ctx, {})
    const header = row(this.ctx, { height: 1, alignItems: "center" })
    const cursor = label(this.ctx, { content: "", width: 2, color: COLORS.accent })
    const glyph = label(this.ctx, { content: "", width: 2 })
    const text = label(this.ctx, { content: "", flexGrow: 1, flexShrink: 1, minWidth: 1 })
    const status = label(this.ctx, { content: "", flexShrink: 0, marginLeft: 1 })
    const discover = label(this.ctx, { content: "", flexShrink: 0, marginLeft: 2, color: COLORS.faint })
    header.add(cursor)
    header.add(glyph)
    header.add(text)
    header.add(status)
    header.add(discover)
    view.add(header)
    const preview = detailPanel(this.ctx, { marginLeft: GUTTER })
    preview.visible = false
    view.add(preview)
    return { task, view, cursor, glyph, text, status, discover, preview, previewLabels: [] }
  }

  private render(): void {
    this.scrollToSelected()
    const visibleEnd = Math.min(this.rows.length, this.offset + MAX_VISIBLE)
    this.rows.forEach((entry, index) => {
      const visible = index >= this.offset && index < visibleEnd
      entry.view.visible = visible
      if (!visible) {
        this.renderPreview(entry, false)
        return
      }
      const active = index === this.selected
      const state = entry.task.state()
      entry.cursor.content = this.focusedFlag && active ? terminalGlyph("❯", ">") : ""
      entry.glyph.content = state.running
        ? new StyledText([paint(COLORS.agent, this.spinner.glyph)])
        : new StyledText([paint(state.ok ? COLORS.success : COLORS.error, state.ok ? "✓" : "x")])
      const name = `${entry.task.id} · ${firstLine(entry.task.title)}`
      entry.text.content =
        this.focusedFlag && active
          ? new StyledText([paint(COLORS.accent, name)])
          : new StyledText([state.running ? paint(COLORS.foreground, name) : muted(name)])
      entry.status.content = new StyledText([
        muted(state.running ? formatDuration(Date.now() - entry.task.startedAt) : state.detail),
      ])
      entry.discover.content = !this.focusedFlag && index === this.offset ? "↓ tasks" : ""
      this.renderPreview(entry, this.expanded && active)
    })
    const hidden = this.rows.length - (visibleEnd - this.offset)
    this.overflow.visible = hidden > 0
    if (hidden > 0) this.overflowText.content = `… +${hidden} more`
    this.hints.visible = this.focusedFlag
    if (this.focusedFlag) {
      const running = this.rows[this.selected]?.task.state().running ?? false
      const view = this.expanded ? "enter collapse" : "enter output"
      const kill = running ? "k kill" : "k dismiss"
      this.hintText.content = `↑↓ move · ${view} · ${kill} · esc back`
    }
  }

  private scrollToSelected(): void {
    const visibleRows = Math.min(this.rows.length, MAX_VISIBLE)
    if (this.selected < this.offset) this.offset = this.selected
    if (this.selected >= this.offset + visibleRows) this.offset = this.selected - visibleRows + 1
    this.offset = Math.min(this.offset, Math.max(0, this.rows.length - visibleRows))
  }

  private renderPreview(entry: TaskRow, active: boolean): void {
    const lines = active ? this.previewLines(entry.task) : []
    entry.preview.visible = lines.length > 0
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
  }

  private previewLines(task: BackgroundTask): string[] {
    const lines = sanitize(task.output().slice(-PREVIEW_KEPT_CHARS))
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0)
      .slice(-PREVIEW_LINES)
    return lines.length > 0 ? lines : ["(no output yet)"]
  }
}
