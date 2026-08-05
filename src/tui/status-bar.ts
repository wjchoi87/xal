import { BoxRenderable, TextAttributes, TextRenderable, type CliRenderer } from "@opentui/core"
import { appInfo } from "../app-info"

export class StatusBar {
  readonly view: BoxRenderable
  private readonly text: TextRenderable

  constructor(renderer: CliRenderer, private readonly model: string) {
    this.view = new BoxRenderable(renderer, { height: 1, paddingLeft: 1, paddingRight: 1 })
    this.text = new TextRenderable(renderer, { content: "", attributes: TextAttributes.DIM })
    this.view.add(this.text)
    this.setState("idle — Enter to send · Ctrl+C twice to quit")
  }

  setState(state: string): void {
    this.text.content = `${appInfo.name} v${appInfo.version} · ${this.model} · ${state}`
  }
}
