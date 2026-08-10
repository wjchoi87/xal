import {
  RenderableEvents,
  StyledText,
  type BoxRenderable,
  type RenderContext,
  type RGBA,
  type TextRenderable,
} from "@opentui/core"
import type { AgentState } from "../../../agent/events"
import type { PermissionMode } from "../../../permissions/types"
import { occupiedContext, type ThinkingEffort, type Usage } from "../../../providers/types"
import { redactText } from "../../../secrets/redactor"
import { formatTokens } from "../lib/format"
import { label, row } from "../lib/renderables"
import { Spinner } from "../lib/spinner"
import { COLORS } from "../theme/colors"
import { muted, paint } from "../theme/styles"

export const STATUS_ROWS = 1

const WIDE = 64

function modeColor(mode: PermissionMode): RGBA {
  if (mode === "plan") return COLORS.success
  if (mode === "auto") return COLORS.warning
  if (mode === "yolo") return COLORS.error
  return COLORS.accent
}

export class StatusBar {
  readonly view: BoxRenderable
  private readonly activity: TextRenderable
  private readonly modeLabel: TextRenderable
  private readonly meta: TextRenderable
  private readonly spinner = new Spinner()
  private state: AgentState = "idle"
  private loading: string | undefined
  private notice: string | undefined
  private contextTokens: number | undefined
  private contextWindow: number | undefined
  private model: string

  constructor(
    ctx: RenderContext,
    model: string,
    private thinking: ThinkingEffort | undefined,
    private mode: PermissionMode,
  ) {
    this.model = redactText(model)
    this.view = row(ctx, { height: STATUS_ROWS, paddingLeft: 2, paddingRight: 2 })
    this.activity = label(ctx, { content: "", flexGrow: 1, flexShrink: 1 })
    this.modeLabel = label(ctx, { content: "", flexShrink: 0, marginLeft: 1 })
    this.meta = label(ctx, {
      content: this.model,
      flexShrink: 0,
      marginLeft: 1,
      color: COLORS.faint,
    })
    this.view.add(this.activity)
    this.view.add(this.meta)
    this.view.add(this.modeLabel)
    this.renderMode()
    this.view.onSizeChange = () => {
      this.renderMeta()
      this.render()
    }
    this.view.on(RenderableEvents.DESTROYED, () => this.spinner.stop())
    this.render()
  }

  setMode(mode: PermissionMode): void {
    this.mode = mode
    this.renderMode()
  }

  setModel(model: string): void {
    this.model = redactText(model)
    this.renderMeta()
  }

  setThinking(thinking: ThinkingEffort | undefined): void {
    this.thinking = thinking
    this.renderMeta()
  }

  private renderMode(): void {
    this.modeLabel.content = new StyledText([muted("· "), paint(modeColor(this.mode), this.mode)])
  }

  setState(state: AgentState): void {
    this.state = state
    this.loading = undefined
    this.notice = undefined
    this.toggleSpinner(this.busy)
    this.render()
  }

  setLoading(loading: string | undefined): void {
    this.loading = loading === undefined ? undefined : redactText(loading)
    this.notice = undefined
    this.toggleSpinner(loading !== undefined)
    this.render()
  }

  setNotice(notice: string): void {
    this.notice = redactText(notice)
    this.toggleSpinner(false)
    this.render()
  }

  clearNotice(): void {
    this.notice = undefined
    this.toggleSpinner(this.loading !== undefined || this.busy)
    this.render()
  }

  private get busy(): boolean {
    return (
      this.state === "streaming" ||
      this.state === "running_hook" ||
      this.state === "running_tool" ||
      this.state === "compacting"
    )
  }

  resetUsage(): void {
    this.contextTokens = undefined
    this.renderMeta()
  }

  setUsage(context: Usage | undefined): void {
    if (context) this.contextTokens = occupiedContext(context)
    this.renderMeta()
  }

  setContextWindow(window: number | undefined): void {
    this.contextWindow = window
    this.renderMeta()
  }

  private renderMeta(): void {
    const thinking = this.thinking ? ` · ${this.thinking === "none" ? "thinking off" : this.thinking}` : ""
    const tokens = this.contextTokens
    if (tokens === undefined) {
      this.meta.content = `${this.model}${thinking}`
      return
    }

    const share = this.contextWindow ? ` (${Math.round((tokens / this.contextWindow) * 100)}%)` : ""
    this.meta.content = `${this.model}${thinking} · ${formatTokens(tokens)}${share}`
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
    if (this.state === "awaiting_input") {
      return new StyledText([paint(COLORS.agent, "?"), muted(" Input needed · answer above")])
    }
    if (this.state !== "idle") {
      const hint = this.view.width > WIDE ? " · Esc interrupt" : ""
      const activity =
        this.state === "compacting" ? "Compacting context" : this.state === "running_hook" ? "Running hooks" : "Working"
      return new StyledText([paint(COLORS.agent, this.spinner.glyph), muted(` ${activity}${hint}`)])
    }
    return new StyledText([muted("")])
  }
}
