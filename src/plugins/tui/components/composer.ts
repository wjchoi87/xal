import {
  BoxRenderable,
  InputRenderable,
  InputRenderableEvents,
  TextAttributes,
  type RenderContext,
} from "@opentui/core"
import { appInfo } from "../../../app-info"
import { label, row } from "../lib/renderables"
import { COLORS } from "../theme/colors"
import { border, inputColors } from "../theme/styles"

export const COMPOSER_ROWS = 4

export interface ComposerActions {
  submit(text: string): boolean
  run(line: string): void
  change(value: string): void
}

export class Composer {
  readonly view: BoxRenderable
  private readonly input: InputRenderable

  constructor(ctx: RenderContext, actions: ComposerActions) {
    this.view = row(ctx, {
      height: 3,
      alignItems: "center",
      border: true,
      borderStyle: "rounded",
      paddingLeft: 1,
      paddingRight: 1,
      marginLeft: 1,
      marginRight: 1,
      marginTop: 1,
      ...border(COLORS.border),
    })

    this.view.add(label(ctx, { content: "❯", width: 2, attributes: TextAttributes.BOLD, color: COLORS.accent }))
    this.input = new InputRenderable(ctx, {
      placeholder: `Ask ${appInfo.name} anything · / for commands`,
      flexGrow: 1,
      minWidth: 1,
      ...inputColors(),
    })
    this.view.add(this.input)

    this.input.on(InputRenderableEvents.INPUT, (value: string) => actions.change(value))

    this.input.on(InputRenderableEvents.ENTER, () => {
      const text = this.input.value.trim()
      if (!text) return
      if (text.startsWith("/")) {
        this.setValue("")
        actions.run(text)
        return
      }
      if (actions.submit(text)) this.setValue("")
    })
  }

  setValue(text: string): void {
    this.input.value = text
  }

  setVisible(visible: boolean): void {
    this.view.visible = visible
  }

  focus(): void {
    this.input.focus()
  }

  blur(): void {
    this.input.blur()
  }
}
