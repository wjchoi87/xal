import {
  BoxRenderable,
  InputRenderable,
  InputRenderableEvents,
  StyledText,
  TextAttributes,
  TextRenderable,
  type CliRenderer,
} from "@opentui/core"
import { appInfo } from "../app-info"
import type { Usage } from "../providers/types"
import { border, COLORS, inputColors, muted, paint, textColors } from "./theme"

function tokenCount(tokens: number): string {
  if (tokens < 1000) return String(tokens)
  if (tokens < 10_000) return `${(tokens / 1000).toFixed(1)}k`
  return `${Math.round(tokens / 1000)}k`
}

export class Composer {
  readonly view: BoxRenderable
  private readonly input: InputRenderable
  private readonly usage: TextRenderable
  private inputTokens = 0
  private outputTokens = 0

  constructor(renderer: CliRenderer, onSubmit: (text: string) => boolean) {
    this.view = new BoxRenderable(renderer, {
      height: 5,
      flexDirection: "column",
      border: true,
      borderStyle: "rounded",
      paddingLeft: 1,
      paddingRight: 1,
      marginLeft: 1,
      marginRight: 1,
      marginTop: 1,
      ...border(COLORS.border),
    })

    const line = new BoxRenderable(renderer, {
      height: 1,
      minWidth: 0,
      flexDirection: "row",
      alignItems: "center",
    })
    line.add(
      new TextRenderable(renderer, {
        content: "›",
        width: 2,
        height: 1,
        attributes: TextAttributes.BOLD,
        ...textColors(COLORS.accent),
      }),
    )
    this.input = new InputRenderable(renderer, {
      placeholder: `Ask ${appInfo.name} anything`,
      flexGrow: 1,
      minWidth: 1,
      ...inputColors(),
    })
    line.add(this.input)
    this.view.add(line)

    const modes = new BoxRenderable(renderer, {
      height: 2,
      minWidth: 0,
      flexDirection: "row",
      alignItems: "center",
      border: ["top"],
      ...border(COLORS.border),
    })
    modes.add(
      new TextRenderable(renderer, {
        content: new StyledText([muted("mode "), paint(COLORS.warning, "agent")]),
        height: 1,
        minWidth: 0,
        flexGrow: 1,
        wrapMode: "none",
        truncate: true,
        ...textColors(),
      }),
    )
    this.usage = new TextRenderable(renderer, {
      content: "",
      height: 1,
      flexShrink: 0,
      marginLeft: 1,
      attributes: TextAttributes.DIM,
      wrapMode: "none",
      ...textColors(),
    })
    modes.add(this.usage)
    this.view.add(modes)

    this.input.on(InputRenderableEvents.ENTER, () => {
      const text = this.input.value.trim()
      if (!text) return
      if (onSubmit(text)) this.input.value = ""
    })
  }

  setUsage(usage: Usage | undefined): void {
    if (!usage) return
    this.inputTokens += usage.inputTokens ?? 0
    this.outputTokens += usage.outputTokens ?? 0
    this.usage.content = `↑${tokenCount(this.inputTokens)} ↓${tokenCount(this.outputTokens)}`
  }

  setPopoverVisible(visible: boolean): void {
    this.view.marginTop = visible ? 0 : 1
  }

  focus(): void {
    this.input.focus()
  }

  blur(): void {
    this.input.blur()
  }
}
