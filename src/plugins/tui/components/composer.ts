import {
  BoxRenderable,
  InputRenderable,
  InputRenderableEvents,
  StyledText,
  TextAttributes,
  type CliRenderer,
  type TextRenderable,
} from "@opentui/core"
import { appInfo } from "../../../app-info"
import type { Usage } from "../../../providers/types"
import { formatTokens } from "../lib/format"
import { column, label, row } from "../lib/renderables"
import { COLORS } from "../theme/colors"
import { border, inputColors, muted, paint } from "../theme/styles"

export class Composer {
  readonly view: BoxRenderable
  private readonly input: InputRenderable
  private readonly usage: TextRenderable
  private inputTokens = 0
  private outputTokens = 0

  constructor(renderer: CliRenderer, onSubmit: (text: string) => boolean) {
    this.view = column(renderer, {
      height: 5,
      border: true,
      borderStyle: "rounded",
      paddingLeft: 1,
      paddingRight: 1,
      marginLeft: 1,
      marginRight: 1,
      marginTop: 1,
      ...border(COLORS.border),
    })

    const prompt = row(renderer, { height: 1, alignItems: "center" })
    prompt.add(label(renderer, { content: "›", width: 2, attributes: TextAttributes.BOLD, color: COLORS.accent }))
    this.input = new InputRenderable(renderer, {
      placeholder: `Ask ${appInfo.name} anything`,
      flexGrow: 1,
      minWidth: 1,
      ...inputColors(),
    })
    prompt.add(this.input)
    this.view.add(prompt)

    const footer = row(renderer, {
      height: 2,
      alignItems: "center",
      border: ["top"],
      ...border(COLORS.border),
    })
    footer.add(
      label(renderer, {
        content: new StyledText([muted("mode "), paint(COLORS.warning, "agent")]),
        flexGrow: 1,
      }),
    )
    this.usage = label(renderer, {
      content: "",
      flexShrink: 0,
      marginLeft: 1,
      attributes: TextAttributes.DIM,
    })
    footer.add(this.usage)
    this.view.add(footer)

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
    this.usage.content = `↑${formatTokens(this.inputTokens)} ↓${formatTokens(this.outputTokens)}`
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
