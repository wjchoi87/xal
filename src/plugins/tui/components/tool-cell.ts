import type { BoxRenderable, CliRenderer, TextRenderable } from "@opentui/core"
import { getToolRenderer, type ToolRenderer } from "../../../ui/extension"
import { formatDuration } from "../lib/format"
import { detailPanel, label, row } from "../lib/renderables"
import { Spinner } from "../lib/spinner"
import { displayWidth, truncateToWidth } from "../lib/text"
import { MAX_OUTPUT_ROWS, renderToolOutput } from "../output/render"
import { summarizeToolOutput, toolOutputFailed } from "../output/summary"
import { COLORS } from "../theme/colors"
import type { Collapsible } from "./chat-entries"
import { activityText, commandLabel, statusText, type ToolOutcome, type ToolPhase } from "./tool-status"

const TICK_MS = 100

export class ToolCell implements Collapsible {
  private readonly view: BoxRenderable
  private readonly command: TextRenderable
  private readonly status: TextRenderable
  private readonly body: BoxRenderable
  private readonly bodyText: TextRenderable
  private readonly activity: TextRenderable
  private readonly spinner = new Spinner(TICK_MS)
  private readonly createdAt = Date.now()
  private readonly title: string
  private readonly waiting: string
  private readonly toolRenderer: ToolRenderer | undefined
  private readonly maxRows: number
  private phase: ToolPhase = "requested"
  private outcome: ToolOutcome = "success"
  private summary = ""
  private output = ""
  private settledAt: number | undefined
  private expanded: boolean

  constructor(
    private readonly renderer: CliRenderer,
    tool: string,
    title: string,
    readOnly: boolean,
    expanded: boolean,
  ) {
    this.toolRenderer = getToolRenderer(tool)
    this.maxRows = this.toolRenderer?.maxRows ?? MAX_OUTPUT_ROWS
    this.expanded = expanded || (this.toolRenderer?.alwaysExpanded ?? false)
    this.title = commandLabel(tool, title)
    this.waiting = this.toolRenderer?.waitingLabel?.(title) ?? `Waiting for ${tool}`

    this.view = row(renderer, { height: 1, alignItems: "center" })
    this.command = label(renderer, { content: this.title, minWidth: 1, flexGrow: 1, flexShrink: 1 })
    this.status = label(renderer, { content: "", flexShrink: 0, marginLeft: 1 })
    this.view.add(label(renderer, { content: readOnly ? ">" : "*", width: 2, color: COLORS.faint }))
    this.view.add(this.command)
    this.view.add(this.status)

    this.body = detailPanel(renderer, { visible: false })
    this.bodyText = label(renderer, { content: "", maxHeight: this.maxRows })
    this.body.add(this.bodyText)

    this.activity = label(renderer, { visible: false, content: "", marginTop: 1 })

    this.view.onSizeChange = () => this.render()
    this.body.onSizeChange = () => this.renderBody()
    this.activity.onSizeChange = () => this.renderActivity()
    this.render()
  }

  addTo(parent: BoxRenderable): void {
    parent.add(this.view)
    parent.add(this.body)
    parent.add(this.activity)
  }

  markRunning(): void {
    this.phase = "running"
    this.activity.visible = true
    this.spinner.start(() => this.render())
    this.render()
  }

  markDenied(message: string): void {
    this.settle("denied", message)
  }

  setOutput(output: string): void {
    const failed = this.toolRenderer?.failed?.(output) ?? toolOutputFailed(output)
    this.settle(failed ? "failure" : "success", output)
  }

  setExpanded(expanded: boolean): void {
    if (this.toolRenderer?.alwaysExpanded) return
    this.expanded = expanded
    this.body.visible = expanded && this.output.length > 0
    if (this.body.visible) this.renderBody()
  }

  private settle(outcome: ToolOutcome, output: string): void {
    this.phase = "settled"
    this.outcome = outcome
    this.output = output
    this.summary =
      outcome === "denied" ? "denied" : (this.toolRenderer?.summarize?.(output) ?? summarizeToolOutput(output))
    this.settledAt = Date.now()
    this.activity.visible = false
    this.spinner.stop()
    this.body.visible = this.expanded && this.output.length > 0
    this.renderBody()
    this.render()
  }

  private render(): void {
    const status = statusText({
      phase: this.phase,
      outcome: this.outcome,
      summary: this.summary,
      elapsed: formatDuration((this.settledAt ?? Date.now()) - this.createdAt),
      width: this.view.width || this.renderer.terminalWidth,
    })
    this.status.content = status.content
    this.renderActivity()
    if (this.view.width <= 0) {
      this.command.content = this.title
      return
    }
    const available = Math.max(1, this.view.width - 3 - displayWidth(status.plain))
    this.command.content = truncateToWidth(this.title, available)
  }

  private renderActivity(): void {
    if (this.phase !== "running") return
    const width = this.activity.width || this.view.width || this.renderer.terminalWidth
    this.activity.content = activityText(this.spinner.glyph, this.waiting, width)
  }

  private renderBody(): void {
    if (!this.output) return
    const width = Math.max(1, (this.body.width || this.view.width) - 2)
    const rendered =
      this.toolRenderer?.renderOutput?.(this.output, width) ?? renderToolOutput(this.output, width, this.maxRows)
    this.bodyText.content = rendered.content
    this.bodyText.height = rendered.rows
  }
}
