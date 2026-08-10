import { StyledText, TextAttributes, type BoxRenderable, type CliRenderer, type TextRenderable } from "@opentui/core"
import type { BackgroundAgentTask } from "../../../background/registry"
import { compactPath } from "../../../lib/path"
import { occupiedContext } from "../../../providers/types"
import { formatDuration, formatTokens } from "../lib/format"
import { column, label, row } from "../lib/renderables"
import { firstLine, sanitize, sliceToWidth, terminalGlyph, truncateToWidth } from "../lib/text"
import { COLORS } from "../theme/colors"
import { border, muted, paint } from "../theme/styles"

const MIN_ROWS = 3
const HORIZONTAL_PADDING = 2

function wrapLine(line: string, width: number): string[] {
  if (!line) return [""]
  const wrapped: string[] = []
  let rest = line
  while (rest) {
    const part = sliceToWidth(rest, width)
    if (!part) break
    wrapped.push(part)
    rest = rest.slice(part.length)
  }
  return wrapped.length > 0 ? wrapped : [""]
}

function styledLine(line: string): StyledText | string {
  if (line.startsWith("> ")) {
    return new StyledText([
      paint(COLORS.success, `${terminalGlyph("●", "*")} `),
      paint(COLORS.foreground, line.slice(2)),
    ])
  }
  if (line.startsWith("✓ ")) {
    return new StyledText([paint(COLORS.success, `${terminalGlyph("└", "`")} `), muted(line.slice(2))])
  }
  if (line.startsWith("x ")) {
    return new StyledText([paint(COLORS.error, "x "), muted(line.slice(2))])
  }
  if (line.includes("denied") || line.startsWith("Sub-agent failed")) {
    return new StyledText([paint(COLORS.error, line)])
  }
  return line
}

export class AgentViewer {
  readonly view: BoxRenderable
  private readonly role: TextRenderable
  private readonly metrics: TextRenderable
  private readonly body: BoxRenderable
  private readonly lines: TextRenderable[] = []
  private task: BackgroundAgentTask | undefined
  private currentHeight = 0

  constructor(private readonly ctx: CliRenderer) {
    this.view = column(ctx, {
      visible: false,
      border: ["top"],
      titleAlignment: "right",
      titleColor: COLORS.accent,
      paddingLeft: HORIZONTAL_PADDING,
      paddingRight: HORIZONTAL_PADDING,
      ...border(COLORS.accent),
    })
    const meta = row(ctx, { height: 1 })
    this.role = label(ctx, {
      content: "",
      flexGrow: 1,
      flexShrink: 1,
      minWidth: 1,
      attributes: TextAttributes.BOLD,
    })
    this.metrics = label(ctx, { content: "", flexShrink: 0, marginLeft: 1, color: COLORS.faint })
    meta.add(this.role)
    meta.add(this.metrics)
    this.view.add(meta)
    this.body = column(ctx, { flexGrow: 1, minHeight: 1, overflow: "hidden" })
    this.view.add(this.body)
  }

  get visible(): boolean {
    return this.task !== undefined
  }

  get height(): number {
    return this.visible ? this.currentHeight : 0
  }

  show(task: BackgroundAgentTask): void {
    this.task = task
    this.view.visible = true
    this.refresh()
  }

  hide(): void {
    this.task = undefined
    this.view.visible = false
  }

  resize(height: number): void {
    const next = Math.max(MIN_ROWS, height)
    if (next === this.currentHeight) {
      this.refresh()
      return
    }
    this.currentHeight = next
    this.view.height = next
    const bodyRows = Math.max(1, next - 2)
    while (this.lines.length > bodyRows) {
      const removed = this.lines.pop()!
      this.body.remove(removed)
      removed.destroyRecursively()
    }
    while (this.lines.length < bodyRows) {
      const added = label(this.ctx, { content: "", color: COLORS.foreground })
      this.body.add(added)
      this.lines.push(added)
    }
    this.refresh()
  }

  refresh(): void {
    const task = this.task
    if (!task) return
    const snapshot = task.snapshot()
    const width = Math.max(10, this.ctx.terminalWidth - HORIZONTAL_PADDING * 2)
    this.view.title = truncateToWidth(firstLine(task.title), Math.max(10, Math.floor(width * 0.6)))
    this.role.content = new StyledText([
      paint(task.state().running ? COLORS.agent : COLORS.foreground, task.state().running ? "● " : "○ "),
      paint(COLORS.foreground, task.role),
      muted(` · ${task.model} · ${compactPath(task.cwd)}`),
    ])
    const tokens = snapshot.usage ? ` · ↓ ${formatTokens(occupiedContext(snapshot.usage))} tokens` : ""
    this.metrics.content = `${formatDuration(snapshot.elapsedMs)}${tokens}`
    const output = sanitize(task.output()).trimEnd()
    const wrapped = (output ? output.split("\n") : [snapshot.activity]).flatMap((line) => wrapLine(line, width))
    const visible = wrapped.slice(-this.lines.length)
    this.lines.forEach((line, index) => {
      const content = visible[index]
      line.content = content === undefined ? "" : styledLine(content)
    })
  }
}
