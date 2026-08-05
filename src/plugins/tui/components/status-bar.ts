import {
  RenderableEvents,
  StyledText,
  TextAttributes,
  type BoxRenderable,
  type CliRenderer,
  type TextRenderable,
} from "@opentui/core"
import type { AgentState } from "../../../agent/events"
import { label, row } from "../lib/renderables"
import { Spinner } from "../lib/spinner"
import { COLORS } from "../theme/colors"
import { muted, paint } from "../theme/styles"

const WIDE = 64
const WIDE_SHORTCUTS = "PgUp/PgDn scroll · Ctrl+O tool output · Ctrl+C quit"
const NARROW_SHORTCUTS = "PgUp/PgDn · Ctrl+O · Ctrl+C"

export class StatusBar {
  readonly view: BoxRenderable
  private readonly activity: TextRenderable
  private readonly spinner = new Spinner()
  private state: AgentState = "idle"
  private loading: string | undefined
  private notice: string | undefined

  constructor(renderer: CliRenderer, model: string) {
    this.view = row(renderer, { height: 1, paddingLeft: 2, paddingRight: 2 })
    this.activity = label(renderer, { content: "", flexGrow: 1, flexShrink: 1 })
    this.view.add(this.activity)
    this.view.add(
      label(renderer, {
        content: model,
        flexShrink: 0,
        marginLeft: 1,
        attributes: TextAttributes.DIM,
        color: COLORS.faint,
      }),
    )
    this.view.onSizeChange = () => this.render()
    this.view.on(RenderableEvents.DESTROYED, () => this.spinner.stop())
    this.render()
  }

  setState(state: AgentState): void {
    this.state = state
    this.loading = undefined
    this.notice = undefined
    this.toggleSpinner(state === "streaming")
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
    this.toggleSpinner(this.loading !== undefined || this.state === "streaming")
    this.render()
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
    if (this.state === "streaming") {
      const hint = this.view.width > WIDE ? " · Esc interrupt" : ""
      return new StyledText([paint(COLORS.agent, this.spinner.glyph), muted(` Working${hint}`)])
    }
    return new StyledText([muted(this.view.width > WIDE ? WIDE_SHORTCUTS : NARROW_SHORTCUTS)])
  }
}
