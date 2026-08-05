import { BorderChars, BoxRenderable, StyledText, TextRenderable, type CliRenderer } from "@opentui/core"
import { getToolRenderer, type ToolRenderer } from "../../ui/extension"
import { border, COLORS, muted, paint, textColors } from "./theme"
import { displayWidth, firstLine, formatDuration, terminalGlyph, truncateToWidth } from "./text"
import { renderToolOutput, summarizeToolOutput, toolOutputFailed } from "./tool-output"

type ToolPhase = "requested" | "running" | "settled"
type ToolOutcome = "success" | "failure" | "denied"

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

function commandLabel(tool: string, title: string): string {
  const task = firstLine(title)
  return task ? `${tool} ${task}` : tool
}

export class ToolCell {
  private readonly row: BoxRenderable
  private readonly command: TextRenderable
  private readonly metadata: TextRenderable
  private readonly body: BoxRenderable
  private readonly bodyText: TextRenderable
  private readonly activity: TextRenderable
  private readonly createdAt = Date.now()
  private readonly label: string
  private readonly waiting: string
  private readonly toolRenderer: ToolRenderer | undefined
  private phase: ToolPhase = "requested"
  private outcome: ToolOutcome = "success"
  private summary = ""
  private output = ""
  private settledAt: number | undefined
  private expanded: boolean
  private frame = 0
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(
    private readonly renderer: CliRenderer,
    tool: string,
    title: string,
    readOnly: boolean,
    expanded: boolean,
  ) {
    this.expanded = expanded
    this.toolRenderer = getToolRenderer(tool)
    this.label = commandLabel(tool, title)
    this.waiting = this.toolRenderer?.waitingLabel?.(title) ?? `Waiting for ${tool}`
    this.row = new BoxRenderable(renderer, {
      height: 1,
      minWidth: 0,
      flexDirection: "row",
      alignItems: "center",
    })
    const glyph = readOnly ? ">" : "*"
    const kind = new TextRenderable(renderer, {
      content: glyph,
      width: 2,
      height: 1,
      ...textColors(COLORS.faint),
    })
    this.command = new TextRenderable(renderer, {
      content: this.label,
      height: 1,
      minWidth: 1,
      flexGrow: 1,
      flexShrink: 1,
      wrapMode: "none",
      truncate: true,
      ...textColors(),
    })
    this.metadata = new TextRenderable(renderer, {
      content: "",
      height: 1,
      flexShrink: 0,
      marginLeft: 1,
      wrapMode: "none",
      ...textColors(),
    })
    this.row.add(kind)
    this.row.add(this.command)
    this.row.add(this.metadata)

    this.body = new BoxRenderable(renderer, {
      visible: expanded,
      flexDirection: "column",
      border: ["left"],
      customBorderChars: { ...BorderChars.single, vertical: terminalGlyph("│", "|") },
      paddingLeft: 1,
      ...border(COLORS.border),
    })
    this.bodyText = new TextRenderable(renderer, {
      content: "",
      height: 1,
      maxHeight: 8,
      wrapMode: "none",
      truncate: true,
      ...textColors(),
    })
    this.body.add(this.bodyText)
    this.activity = new TextRenderable(renderer, {
      visible: false,
      content: "",
      height: 1,
      minWidth: 0,
      marginTop: 1,
      wrapMode: "none",
      truncate: true,
      ...textColors(),
    })
    this.row.onSizeChange = () => this.update()
    this.body.onSizeChange = () => this.renderBody()
    this.activity.onSizeChange = () => this.renderActivity()
    this.update()
  }

  addTo(parent: BoxRenderable): void {
    parent.add(this.row)
    parent.add(this.body)
    parent.add(this.activity)
  }

  markRunning(): void {
    this.phase = "running"
    this.activity.visible = true
    this.startTimer()
    this.update()
  }

  markDenied(message: string): void {
    this.settle("denied", message)
  }

  setOutput(output: string): void {
    const failed = this.toolRenderer?.failed?.(output) ?? toolOutputFailed(output)
    this.settle(failed ? "failure" : "success", output)
  }

  setExpanded(expanded: boolean): void {
    this.expanded = expanded
    this.body.visible = expanded
    if (expanded) this.renderBody()
  }

  private settle(outcome: ToolOutcome, output: string): void {
    this.phase = "settled"
    this.outcome = outcome
    this.output = output
    this.summary =
      outcome === "denied" ? "denied" : (this.toolRenderer?.summarize?.(output) ?? summarizeToolOutput(output))
    this.settledAt = Date.now()
    this.activity.visible = false
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    this.renderBody()
    this.update()
  }

  private startTimer(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.update(), 100)
  }

  private elapsed(): string {
    return formatDuration((this.settledAt ?? Date.now()) - this.createdAt)
  }

  private metadataParts(): { content: StyledText; plain: string } {
    const width = this.row.width || this.renderer.terminalWidth
    if (this.phase !== "settled") {
      const state = this.phase === "requested" ? "approval" : "running"
      const plain = width > 52 ? `${state} - ${this.elapsed()}` : state
      return { content: new StyledText([paint(COLORS.warning, plain)]), plain }
    }

    const glyph = this.outcome === "success" ? "✓" : "x"
    const color = this.outcome === "success" ? COLORS.success : COLORS.error
    let detail = ""
    if (width >= 68) detail = ` ${this.summary} - ${this.elapsed()}`
    else if (width >= 46) detail = ` ${this.summary}`
    return {
      content: new StyledText([paint(color, glyph), muted(detail)]),
      plain: `${glyph}${detail}`,
    }
  }

  private update(): void {
    const metadata = this.metadataParts()
    this.metadata.content = metadata.content
    this.renderActivity()
    if (this.row.width <= 0) {
      this.command.content = this.label
      return
    }
    const available = Math.max(1, this.row.width - 3 - displayWidth(metadata.plain))
    this.command.content = truncateToWidth(this.label, available)
  }

  private renderActivity(): void {
    if (this.phase !== "running") return
    const spinner = terminalGlyph(SPINNER_FRAMES[this.frame]!, "*")
    const width = this.activity.width || this.row.width || this.renderer.terminalWidth
    const hint = width >= displayWidth(this.waiting) + 24 ? " · esc to interrupt" : ""
    this.activity.content = new StyledText([
      paint(COLORS.agent, spinner),
      muted(` ${this.waiting}`),
      paint(COLORS.faint, hint),
    ])
    this.frame = (this.frame + 1) % SPINNER_FRAMES.length
  }

  private renderBody(): void {
    if (!this.output) return
    const width = Math.max(1, (this.body.width || this.row.width) - 2)
    const rendered = this.toolRenderer?.renderOutput?.(this.output, width) ?? renderToolOutput(this.output, width)
    this.bodyText.content = rendered.content
    this.bodyText.height = rendered.rows
  }
}
