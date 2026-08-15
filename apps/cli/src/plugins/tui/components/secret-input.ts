import {
  StyledText,
  type BoxRenderable,
  type KeyEvent,
  type PasteEvent,
  type RenderContext,
  type TextRenderable,
} from "@opentui/core"
import { label, row } from "../lib/renderables"
import { COLORS } from "../theme/colors"
import { background, border, muted, paint } from "../theme/styles"

export class SecretInput {
  readonly view: BoxRenderable
  readonly height = 4
  private readonly prompt: TextRenderable
  private readonly masked: TextRenderable
  private value = ""
  private settle: ((value: string | undefined) => void) | undefined

  get visible(): boolean {
    return this.view.visible
  }

  constructor(
    ctx: RenderContext,
    private readonly onChange: () => void,
  ) {
    this.view = row(ctx, {
      visible: false,
      height: 3,
      border: true,
      borderStyle: "rounded",
      paddingLeft: 1,
      paddingRight: 1,
      marginLeft: 1,
      marginRight: 1,
      marginTop: 1,
      ...background(),
      ...border(COLORS.agent),
    })
    this.prompt = label(ctx, { content: "", flexShrink: 0 })
    this.masked = label(ctx, { content: "", flexGrow: 1, flexShrink: 1, minWidth: 1, marginLeft: 1 })
    this.view.add(this.prompt)
    this.view.add(this.masked)
    this.view.add(label(ctx, { content: "Enter · Esc", flexShrink: 0, marginLeft: 1, color: COLORS.faint }))
  }

  show(question: string): Promise<string | undefined> {
    this.close(undefined)
    this.prompt.content = new StyledText([paint(COLORS.agent, `${question}:`)])
    this.value = ""
    this.render()
    this.view.visible = true
    this.onChange()
    return new Promise((settle) => {
      this.settle = settle
    })
  }

  hide(): void {
    this.close(undefined)
  }

  handleKey(key: KeyEvent): boolean {
    if (!this.visible) return false
    if (key.name === "escape") {
      this.close(undefined)
      return true
    }
    if (key.name === "return" || key.name === "enter") {
      this.close(this.value)
      return true
    }
    if (key.ctrl && key.name === "u") {
      this.value = ""
      this.render()
      return true
    }
    if (key.name === "backspace" || key.name === "delete") {
      this.value = Array.from(this.value).slice(0, -1).join("")
      this.render()
      return true
    }
    if (key.ctrl || key.meta || !key.sequence || /[\u0000-\u001f\u007f]/.test(key.sequence)) return true
    this.value += key.sequence
    this.render()
    return true
  }

  handlePaste(event: PasteEvent): boolean {
    if (!this.visible) return false
    this.value += new TextDecoder().decode(event.bytes).replace(/[\r\n]/g, "")
    this.render()
    return true
  }

  private close(value: string | undefined): void {
    const settle = this.settle
    this.settle = undefined
    this.value = ""
    this.masked.content = ""
    if (this.view.visible) {
      this.view.visible = false
      this.onChange()
    }
    settle?.(value)
  }

  private render(): void {
    const count = Array.from(this.value).length
    this.masked.content = count === 0 ? new StyledText([muted("paste or type token")]) : "•".repeat(count)
  }
}
