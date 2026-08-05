import {
  BoxRenderable,
  ScrollBoxRenderable,
  TextAttributes,
  TextRenderable,
  type CliRenderer,
} from "@opentui/core"

const DISPLAY_OUTPUT_LIMIT = 1500

export class StreamingText {
  private buffer = ""

  constructor(private readonly text: TextRenderable) {}

  append(delta: string): void {
    this.buffer += delta
    this.text.content = this.buffer
  }
}

export class ToolCell {
  constructor(
    private readonly renderer: CliRenderer,
    private readonly box: BoxRenderable,
    private readonly status: TextRenderable,
  ) {}

  markRunning(): void {
    this.box.borderColor = "#666666"
    this.status.content = "running…"
  }

  markDenied(message: string): void {
    this.box.borderColor = "#E06C75"
    this.status.content = message
  }

  setOutput(output: string): void {
    this.box.borderColor = "#666666"
    let display = output
    if (display.length > DISPLAY_OUTPUT_LIMIT) {
      display = display.slice(0, DISPLAY_OUTPUT_LIMIT) + `\n… (${display.length - DISPLAY_OUTPUT_LIMIT} more characters)`
    }
    this.status.content = display || "(no output)"
  }
}

export class ChatLog {
  readonly view: ScrollBoxRenderable

  constructor(private readonly renderer: CliRenderer) {
    this.view = new ScrollBoxRenderable(renderer, {
      flexGrow: 1,
      stickyScroll: true,
      stickyStart: "bottom",
      paddingLeft: 1,
      paddingRight: 1,
    })
  }

  private cell(): BoxRenderable {
    const box = new BoxRenderable(this.renderer, { flexDirection: "column", marginTop: 1 })
    this.view.add(box)
    return box
  }

  addUser(text: string): void {
    const box = this.cell()
    box.add(new TextRenderable(this.renderer, { content: `❯ ${text}`, fg: "#61AFEF", wrapMode: "word" }))
  }

  addInfo(text: string): void {
    const box = this.cell()
    box.add(
      new TextRenderable(this.renderer, { content: text, attributes: TextAttributes.DIM, wrapMode: "word" }),
    )
  }

  addError(text: string): void {
    const box = this.cell()
    box.add(new TextRenderable(this.renderer, { content: `✗ ${text}`, fg: "#E06C75", wrapMode: "word" }))
  }

  startAssistant(): StreamingText {
    const box = this.cell()
    const text = new TextRenderable(this.renderer, { content: "", wrapMode: "word" })
    box.add(text)
    return new StreamingText(text)
  }

  startThinking(): StreamingText {
    const box = this.cell()
    const text = new TextRenderable(this.renderer, {
      content: "",
      attributes: TextAttributes.DIM | TextAttributes.ITALIC,
      wrapMode: "word",
    })
    box.add(text)
    return new StreamingText(text)
  }

  addToolCell(command: string): ToolCell {
    const box = new BoxRenderable(this.renderer, {
      flexDirection: "column",
      marginTop: 1,
      border: true,
      borderStyle: "rounded",
      borderColor: "#E5C07B",
      title: "bash",
      paddingLeft: 1,
      paddingRight: 1,
    })
    this.view.add(box)
    box.add(new TextRenderable(this.renderer, { content: `$ ${command}`, fg: "#98C379", wrapMode: "word" }))
    const status = new TextRenderable(this.renderer, {
      content: "[y] run · [n] deny · [Esc] interrupt",
      attributes: TextAttributes.DIM,
      wrapMode: "word",
    })
    box.add(status)
    return new ToolCell(this.renderer, box, status)
  }
}
