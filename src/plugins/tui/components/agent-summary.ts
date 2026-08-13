import {
  RenderableEvents,
  StyledText,
  TextAttributes,
  type BoxRenderable,
  type RenderContext,
  type TextRenderable,
} from "@opentui/core"
import { listBackgroundTasks, subscribeBackgroundTasks, type BackgroundAgentTask } from "../../../background/registry"
import { occupiedContext } from "../../../providers/types"
import { redactText } from "../../../secrets/redactor"
import { formatTokens } from "../lib/format"
import { column, label, row } from "../lib/renderables"
import { Spinner } from "../lib/spinner"
import { firstLine, terminalGlyph } from "../lib/text"
import { COLORS } from "../theme/colors"
import { muted, paint } from "../theme/styles"

const TICK_MS = 100

interface AgentRow {
  view: BoxRenderable
  title: TextRenderable
  metrics: TextRenderable
  branch: TextRenderable
  activity: TextRenderable
}

export class AgentSummary {
  readonly view: BoxRenderable
  private readonly spinnerLabel: TextRenderable
  private readonly heading: TextRenderable
  private readonly rows = new Map<string, AgentRow>()
  private readonly spinner = new Spinner(TICK_MS)
  private agents: BackgroundAgentTask[] = []

  constructor(
    private readonly ctx: RenderContext,
    private readonly onChange: () => void,
  ) {
    this.view = column(ctx, { visible: false })
    const header = row(ctx, { height: 1 })
    this.spinnerLabel = label(ctx, { content: "", width: 2, color: COLORS.agent })
    this.heading = label(ctx, { content: "", flexGrow: 1, flexShrink: 1, minWidth: 1 })
    header.add(this.spinnerLabel)
    header.add(this.heading)
    this.view.add(header)
    const unsubscribe = subscribeBackgroundTasks(() => this.sync())
    this.view.on(RenderableEvents.DESTROYED, () => {
      unsubscribe()
      this.spinner.stop()
    })
  }

  get height(): number {
    return this.agents.length === 0 ? 0 : 2 + this.agents.length * 2
  }

  private sync(): void {
    const agents = listBackgroundTasks().filter(
      (task): task is BackgroundAgentTask => task.kind === "agent" && task.state().running,
    )
    const changed =
      agents.length !== this.agents.length || agents.some((agent, index) => agent.id !== this.agents[index]?.id)
    this.agents = agents
    if (changed) this.rebuild()
    if (agents.length > 0) this.spinner.start(() => this.render())
    else this.spinner.stop()
    this.render()
    this.onChange()
  }

  private rebuild(): void {
    for (const entry of this.rows.values()) {
      this.view.remove(entry.view)
      entry.view.destroyRecursively()
    }
    this.rows.clear()
    this.view.visible = this.agents.length > 0
    for (const agent of this.agents) {
      const view = column(this.ctx, {})
      const titleRow = row(this.ctx, { height: 1 })
      const branch = label(this.ctx, { content: "", width: 3, color: COLORS.faint })
      const title = label(this.ctx, {
        content: "",
        flexGrow: 1,
        flexShrink: 1,
        minWidth: 1,
        attributes: TextAttributes.BOLD,
      })
      const metrics = label(this.ctx, { content: "", flexShrink: 0, marginLeft: 1, color: COLORS.faint })
      titleRow.add(branch)
      titleRow.add(title)
      titleRow.add(metrics)
      view.add(titleRow)
      const activityRow = row(this.ctx, { height: 1 })
      activityRow.add(label(this.ctx, { content: "", width: 5, color: COLORS.faint }))
      const activity = label(this.ctx, { content: "", flexGrow: 1, flexShrink: 1, minWidth: 1, color: COLORS.faint })
      activityRow.add(activity)
      view.add(activityRow)
      this.view.add(view)
      this.rows.set(agent.id, { view, title, metrics, branch, activity })
    }
    this.view.marginTop = this.agents.length === 0 ? 0 : 1
  }

  private render(): void {
    if (this.agents.length === 0) return
    this.spinnerLabel.content = this.spinner.glyph
    const noun = this.agents.length === 1 ? "agent" : "agents"
    this.heading.content = new StyledText([
      paint(COLORS.foreground, `Running ${this.agents.length} ${noun}…`),
      muted("  (↓ agents)"),
    ])
    this.agents.forEach((agent, index) => {
      const entry = this.rows.get(agent.id)
      if (!entry) return
      const snapshot = agent.snapshot()
      const last = index === this.agents.length - 1
      entry.branch.content = `${terminalGlyph(last ? "└" : "├", last ? "`" : "|")} `
      entry.title.content = firstLine(redactText(agent.title))
      const toolCount = `${snapshot.toolCount} tool ${snapshot.toolCount === 1 ? "use" : "uses"}`
      const tokens = snapshot.usage ? ` · ${formatTokens(occupiedContext(snapshot.usage))} tokens` : ""
      entry.metrics.content = `${toolCount}${tokens}`
      entry.activity.content = redactText(`${terminalGlyph("└", "`")} ${snapshot.activity}`)
    })
  }
}
