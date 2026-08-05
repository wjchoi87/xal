import {
  RenderableEvents,
  StyledText,
  TextAttributes,
  type BoxRenderable,
  type RenderContext,
  type TextRenderable,
} from "@opentui/core"
import type { AgentState } from "../../../agent/events"
import type { Usage } from "../../../providers/types"
import { formatTokens } from "../lib/format"
import { label, row } from "../lib/renderables"
import { Spinner } from "../lib/spinner"
import { COLORS } from "../theme/colors"
import { muted, paint } from "../theme/styles"

export const STATUS_ROWS = 1

const WIDE = 64
const WIDE_SHORTCUTS = "Ctrl+O tool output · Ctrl+C quit"
const NARROW_SHORTCUTS = "Ctrl+O · Ctrl+C"

export class StatusBar {
  readonly view: BoxRenderable
  private readonly activity: TextRenderable
  private readonly meta: TextRenderable
  private readonly spinner = new Spinner()
  private state: AgentState = "idle"
  private loading: string | undefined
  private notice: string | undefined
  private inputTokens = 0
  private outputTokens = 0

  constructor(
    ctx: RenderContext,
    private readonly model: string,
  ) {
    this.view = row(ctx, { height: STATUS_ROWS, paddingLeft: 2, paddingRight: 2 })
    this.activity = label(ctx, { content: "", flexGrow: 1, flexShrink: 1 })
    this.meta = label(ctx, {
      content: model,
      flexShrink: 0,
      marginLeft: 1,
      attributes: TextAttributes.DIM,
      color: COLORS.faint,
    })
    this.view.add(this.activity)
    this.view.add(this.meta)
    this.view.onSizeChange = () => this.render()
    this.view.on(RenderableEvents.DESTROYED, () => this.spinner.stop())
    this.render()
  }

  setState(state: AgentState): void {
    this.state = state
    this.loading = undefined
    this.notice = undefined
    this.toggleSpinner(this.busy)
    this.render()
  }

  setLoading(loading: string | undefined): void {
    this.loading = loading
    this.notice = undefined
    this.toggleSpinner(loading !== undefined)
    this.render()
  }

  setNotice(notice: string): void {
    this.notice = notice
    this.toggleSpinner(false)
    this.render()
  }

  clearNotice(): void {
    this.notice = undefined
    this.toggleSpinner(this.loading !== undefined || this.busy)
    this.render()
  }

  private get busy(): boolean {
    return this.state === "streaming" || this.state === "running_tool"
  }

  setUsage(usage: Usage | undefined): void {
    if (!usage) return
    this.inputTokens += usage.inputTokens ?? 0
    this.outputTokens += usage.outputTokens ?? 0
    this.meta.content = `${this.model} · ↑${formatTokens(this.inputTokens)} ↓${formatTokens(this.outputTokens)}`
  }

  private toggleSpinner(active: boolean): void {
    if (active) this.spinner.start(() => this.render())
    else this.spinner.stop()
  }

  private render(): void {
    this.activity.content = this.content()
  }

  private content(): StyledText {
    if (this.notice) return new StyledText([muted(this.notice)])
    if (this.loading) {
      return new StyledText([paint(COLORS.agent, this.spinner.glyph), muted(` ${this.loading}`)])
    }
    if (this.state === "awaiting_approval") {
      return new StyledText([paint(COLORS.warning, "!"), muted(" Approval needed · choose above")])
    }
    if (this.state !== "idle") {
      const hint = this.view.width > WIDE ? " · Esc interrupt" : ""
      return new StyledText([paint(COLORS.agent, this.spinner.glyph), muted(` Working${hint}`)])
    }
    return new StyledText([muted(this.view.width > WIDE ? WIDE_SHORTCUTS : NARROW_SHORTCUTS)])
  }
}
