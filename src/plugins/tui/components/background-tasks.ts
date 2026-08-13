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
  type BackgroundAgentTask,
  type BackgroundTask,
} from "../../../background/registry"
import { describeError } from "../../../lib/error"
import { occupiedContext } from "../../../providers/types"
import { redactText } from "../../../secrets/redactor"
import { formatDuration, formatTokens } from "../lib/format"
import { column, detailPanel, label, row } from "../lib/renderables"
import { Spinner } from "../lib/spinner"
import { firstLine, sanitize, terminalGlyph } from "../lib/text"
import { COLORS } from "../theme/colors"
import { muted, paint } from "../theme/styles"

const TICK_MS = 100
const MAX_VISIBLE = 5
const PREVIEW_LINES = 8
const PREVIEW_KEPT_CHARS = 4_000
const GUTTER = 4

export interface BackgroundTasksActions {
  changed(): void
  released(): void
  viewAgent(task: BackgroundAgentTask | undefined): void
  error(message: string): void
}

interface RowRenderables {
  view: BoxRenderable
  cursor: TextRenderable
  glyph: TextRenderable
  text: TextRenderable
  status: TextRenderable
  discover: TextRenderable
  preview: BoxRenderable
  previewLabels: TextRenderable[]
}

interface MainRow extends RowRenderables {
  kind: "main"
}

interface TaskRow extends RowRenderables {
  kind: "task"
  task: BackgroundTask
}

type NavigatorRow = MainRow | TaskRow

function rowId(entry: NavigatorRow): string {
  return entry.kind === "main" ? "main" : entry.task.id
}

function isAgent(task: BackgroundTask): task is BackgroundAgentTask {
  return task.kind === "agent"
}

export class BackgroundTasks {
  readonly view: BoxRenderable
  private readonly overflow: BoxRenderable
  private readonly overflowText: TextRenderable
  private readonly hints: BoxRenderable
  private readonly hintText: TextRenderable
  private rows: NavigatorRow[] = []
  private readonly spinner = new Spinner(TICK_MS)
  private focusedFlag = false
  private selected = 0
  private offset = 0
  private expanded = false
  private viewedAgentId: string | undefined

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
    const selected = this.rows[this.selected]
    const preview = this.expanded && selected?.kind === "task" ? selected.previewLabels.length : 0
    return 1 + visible + overflow + hints + preview
  }

  get count(): number {
    return this.rows.length
  }

  get focused(): boolean {
    return this.focusedFlag
  }

  get hasRunningAgents(): boolean {
    return this.rows.some((entry) => entry.kind === "task" && entry.task.kind === "agent" && entry.task.state().running)
  }

  focus(): void {
    if (this.rows.length === 0 || this.focusedFlag) return
    this.focusedFlag = true
    const viewed = this.viewedAgentId
    if (viewed) {
      const index = this.rows.findIndex((entry) => entry.kind === "task" && entry.task.id === viewed)
      if (index >= 0) this.selected = index
    }
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
      this.expanded = false
      this.render()
      return true
    }
    if (name === "return" || name === "enter") {
      const entry = this.rows[this.selected]
      if (!entry) return true
      if (entry.kind === "main") {
        this.viewAgent(undefined)
      } else if (entry.task.kind === "agent") {
        this.viewAgent(entry.task.id === this.viewedAgentId ? undefined : entry.task)
      } else {
        this.expanded = !this.expanded
      }
      this.render()
      return true
    }
    if (name === "x" || name === "k") {
      const entry = this.rows[this.selected]
      if (!entry || entry.kind === "main") return true
      if (entry.task.state().running) {
        entry.task.stop().catch((error: unknown) => this.actions.error(describeError(error)))
      } else {
        if (entry.task.id === this.viewedAgentId) this.viewAgent(undefined)
        this.expanded = false
        removeBackgroundTask(entry.task.id)
      }
      return true
    }
    if (name === "escape") {
      if (this.viewedAgentId) {
        this.viewAgent(undefined)
        this.render()
        return true
      }
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

  closeViewer(): boolean {
    if (this.viewedAgentId === undefined) return false
    this.viewAgent(undefined)
    this.render()
    return true
  }

  stopAllAgents(): boolean {
    const agents = listBackgroundTasks().filter((task) => task.kind === "agent" && task.state().running)
    for (const agent of agents) {
      agent.stop().catch((error: unknown) => this.actions.error(describeError(error)))
    }
    return agents.length > 0
  }

  private viewAgent(task: BackgroundAgentTask | undefined): void {
    this.viewedAgentId = task?.id
    this.expanded = false
    this.actions.viewAgent(task)
  }

  private sync(): void {
    const tasks = listBackgroundTasks()
    const agents = tasks.filter(isAgent)
    const ordered = [...agents, ...tasks.filter((task) => task.kind === "process")]
    const ids = agents.length > 0 ? ["main", ...ordered.map((task) => task.id)] : ordered.map((task) => task.id)
    if (ids.length !== this.rows.length || ids.some((id, index) => id !== rowId(this.rows[index]!))) {
      this.rebuild(tasks, agents.length > 0)
    }
    if (this.viewedAgentId && !agents.some((agent) => agent.id === this.viewedAgentId)) this.viewAgent(undefined)
    if (tasks.length === 0 && this.focusedFlag) {
      this.blur()
      this.actions.released()
    }
    if (tasks.some((task) => task.state().running)) this.spinner.start(() => this.render())
    else this.spinner.stop()
    this.render()
    this.actions.changed()
  }

  private rebuild(tasks: BackgroundTask[], includeMain: boolean): void {
    const selectedId = this.rows[this.selected] ? rowId(this.rows[this.selected]!) : undefined
    for (const entry of this.rows) {
      this.view.remove(entry.view)
      entry.view.destroyRecursively()
    }
    this.view.remove(this.overflow)
    this.view.remove(this.hints)
    this.rows = []
    if (includeMain) this.rows.push(this.createMainRow())
    this.rows.push(...tasks.filter(isAgent).map((task) => this.createTaskRow(task)))
    this.rows.push(...tasks.filter((task) => task.kind === "process").map((task) => this.createTaskRow(task)))
    for (const entry of this.rows) this.view.add(entry.view)
    this.view.add(this.overflow)
    this.view.add(this.hints)
    const kept = this.rows.findIndex((entry) => rowId(entry) === selectedId)
    this.selected = kept >= 0 ? kept : Math.min(this.selected, Math.max(0, this.rows.length - 1))
    this.view.marginTop = this.rows.length === 0 ? 0 : 1
  }

  private rowRenderables(): RowRenderables {
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
    return { view, cursor, glyph, text, status, discover, preview, previewLabels: [] }
  }

  private createMainRow(): MainRow {
    return { kind: "main", ...this.rowRenderables() }
  }

  private createTaskRow(task: BackgroundTask): TaskRow {
    return { kind: "task", task, ...this.rowRenderables() }
  }

  private render(): void {
    this.scrollToSelected()
    const visibleEnd = Math.min(this.rows.length, this.offset + MAX_VISIBLE)
    const hasAgents = this.rows.some((entry) => entry.kind === "task" && entry.task.kind === "agent")
    this.rows.forEach((entry, index) => {
      const visible = index >= this.offset && index < visibleEnd
      entry.view.visible = visible
      if (!visible) {
        this.renderPreview(entry, false)
        return
      }
      const active = index === this.selected
      entry.cursor.content = this.focusedFlag && active ? terminalGlyph("❯", ">") : ""
      if (entry.kind === "main") this.renderMain(entry, active)
      else this.renderTask(entry, active)
      entry.discover.content = !this.focusedFlag && index === this.offset ? `↓ ${hasAgents ? "agents" : "tasks"}` : ""
      this.renderPreview(entry, this.expanded && active)
    })
    const hidden = this.rows.length - (visibleEnd - this.offset)
    this.overflow.visible = hidden > 0
    if (hidden > 0) this.overflowText.content = `… +${hidden} more`
    this.hints.visible = this.focusedFlag
    if (this.focusedFlag) this.hintText.content = this.hint()
  }

  private renderMain(entry: MainRow, active: boolean): void {
    const viewingMain = this.viewedAgentId === undefined
    entry.glyph.content = new StyledText([
      paint(
        viewingMain ? COLORS.foreground : COLORS.faint,
        terminalGlyph(viewingMain ? "●" : "○", viewingMain ? "*" : "o"),
      ),
    ])
    entry.text.content = active
      ? new StyledText([paint(COLORS.accent, "main")])
      : new StyledText([paint(viewingMain ? COLORS.foreground : COLORS.faint, "main")])
    entry.status.content = ""
  }

  private renderTask(entry: TaskRow, active: boolean): void {
    const state = entry.task.state()
    if (entry.task.kind === "agent") {
      const viewed = entry.task.id === this.viewedAgentId
      const glyph = state.running ? terminalGlyph(viewed ? "●" : "○", viewed ? "*" : "o") : state.ok ? "✓" : "x"
      const glyphColor = state.running
        ? viewed
          ? COLORS.foreground
          : COLORS.faint
        : state.ok
          ? COLORS.success
          : COLORS.error
      entry.glyph.content = new StyledText([paint(glyphColor, glyph)])
      const name = `${entry.task.id} · ${redactText(entry.task.role)} · ${firstLine(redactText(entry.task.title))}`
      entry.text.content = active
        ? new StyledText([paint(COLORS.accent, name)])
        : new StyledText([state.running || viewed ? paint(COLORS.foreground, name) : muted(name)])
      const snapshot = entry.task.snapshot()
      const tokens = snapshot.usage ? ` · ↓ ${formatTokens(occupiedContext(snapshot.usage))} tokens` : ""
      entry.status.content = new StyledText([
        muted(state.running ? `${formatDuration(snapshot.elapsedMs)}${tokens}` : redactText(state.detail)),
      ])
      return
    }
    entry.glyph.content = state.running
      ? new StyledText([paint(COLORS.agent, this.spinner.glyph)])
      : new StyledText([paint(state.ok ? COLORS.success : COLORS.error, state.ok ? "✓" : "x")])
    const name = `${entry.task.id} · ${firstLine(redactText(entry.task.title))}`
    entry.text.content = active
      ? new StyledText([paint(COLORS.accent, name)])
      : new StyledText([state.running ? paint(COLORS.foreground, name) : muted(name)])
    entry.status.content = new StyledText([
      muted(state.running ? formatDuration(Date.now() - entry.task.startedAt) : redactText(state.detail)),
    ])
  }

  private hint(): string {
    const entry = this.rows[this.selected]
    if (!entry || entry.kind === "main") return "↑↓ move · enter main · ctrl+x ctrl+k stop all · esc back"
    if (entry.task.kind === "agent") {
      const open = entry.task.id === this.viewedAgentId ? "enter close" : "enter view"
      const action = entry.task.state().running ? "x stop" : "x dismiss"
      return `↑↓ move · ${open} · ${action} · ctrl+x ctrl+k stop all · esc back`
    }
    const view = this.expanded ? "enter collapse" : "enter output"
    const action = entry.task.state().running ? "x stop" : "x dismiss"
    return `↑↓ move · ${view} · ${action} · esc back`
  }

  private scrollToSelected(): void {
    const visibleRows = Math.min(this.rows.length, MAX_VISIBLE)
    if (this.selected < this.offset) this.offset = this.selected
    if (this.selected >= this.offset + visibleRows) this.offset = this.selected - visibleRows + 1
    this.offset = Math.min(this.offset, Math.max(0, this.rows.length - visibleRows))
  }

  private renderPreview(entry: NavigatorRow, active: boolean): void {
    const lines = active && entry.kind === "task" && entry.task.kind === "process" ? this.previewLines(entry.task) : []
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
    const lines = sanitize(redactText(task.output().slice(-PREVIEW_KEPT_CHARS)))
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0)
      .slice(-PREVIEW_LINES)
    return lines.length > 0 ? lines : ["(no output yet)"]
  }
}
