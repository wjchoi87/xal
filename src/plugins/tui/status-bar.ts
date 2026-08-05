import {
  BoxRenderable,
  RenderableEvents,
  StyledText,
  TextAttributes,
  TextRenderable,
  type CliRenderer,
} from "@opentui/core"
import type { AgentState } from "../../agent/events"
import { COLORS, muted, paint, textColors } from "./theme"
import { terminalGlyph } from "./text"

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

export class StatusBar {
  readonly view: BoxRenderable
  private readonly activity: TextRenderable
  private readonly model: TextRenderable
  private state: AgentState = "idle"
  private notice: string | undefined
  private frame = 0
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(renderer: CliRenderer, model: string) {
    this.view = new BoxRenderable(renderer, {
      height: 1,
      minWidth: 0,
      flexDirection: "row",
      paddingLeft: 2,
      paddingRight: 2,
    })
    this.activity = new TextRenderable(renderer, {
      content: "",
      height: 1,
      minWidth: 0,
      flexGrow: 1,
      flexShrink: 1,
      wrapMode: "none",
      truncate: true,
      ...textColors(),
    })
    this.model = new TextRenderable(renderer, {
      content: model,
      height: 1,
      flexShrink: 0,
      marginLeft: 1,
      attributes: TextAttributes.DIM,
      wrapMode: "none",
      truncate: true,
      ...textColors(COLORS.faint),
    })
    this.view.add(this.activity)
    this.view.add(this.model)
    this.view.onSizeChange = () => this.render()
    this.view.on(RenderableEvents.DESTROYED, () => this.stopSpinner())
    this.render()
  }

  setState(state: AgentState): void {
    this.state = state
    this.notice = undefined
    if (state === "streaming") this.startSpinner()
    else this.stopSpinner()
    this.render()
  }

  setNotice(notice: string): void {
    this.notice = notice
    this.stopSpinner()
    this.render()
  }

  private startSpinner(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      this.frame = (this.frame + 1) % SPINNER_FRAMES.length
      this.render()
    }, 110)
  }

  private stopSpinner(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    this.frame = 0
  }

  private render(): void {
    if (this.notice) {
      this.activity.content = new StyledText([muted(this.notice)])
      return
    }
    if (this.state === "awaiting_approval") {
      this.activity.content = new StyledText([
        paint(COLORS.warning, "!"),
        muted(" Approval needed · choose above"),
      ])
      return
    }
    if (this.state === "streaming") {
      const hint = this.view.width > 64 ? " · Esc interrupt" : ""
      const spinner = terminalGlyph(SPINNER_FRAMES[this.frame]!, "*")
      this.activity.content = new StyledText([
        paint(COLORS.agent, spinner),
        muted(` Working${hint}`),
      ])
      return
    }
    const shortcuts =
      this.view.width > 64
        ? "PgUp/PgDn scroll · Ctrl+O tool output · Ctrl+C quit"
        : "PgUp/PgDn · Ctrl+O · Ctrl+C"
    this.activity.content = new StyledText([muted(shortcuts)])
  }
}
