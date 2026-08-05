import { BoxRenderable, InputRenderable, InputRenderableEvents, type CliRenderer } from "@opentui/core"

export class Composer {
  readonly view: BoxRenderable
  private readonly input: InputRenderable

  constructor(renderer: CliRenderer, onSubmit: (text: string) => void) {
    this.view = new BoxRenderable(renderer, {
      border: true,
      borderStyle: "rounded",
      borderColor: "#666666",
      height: 3,
      paddingLeft: 1,
      paddingRight: 1,
    })
    this.input = new InputRenderable(renderer, { placeholder: "type a message…" })
    this.view.add(this.input)
    this.input.on(InputRenderableEvents.ENTER, () => {
      const text = this.input.value.trim()
      if (!text) return
      this.input.value = ""
      onSubmit(text)
    })
  }

  focus(): void {
    this.input.focus()
  }

  blur(): void {
    this.input.blur()
  }
}
