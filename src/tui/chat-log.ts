import {
  BoxRenderable,
  ScrollBoxRenderable,
  StyledText,
  TextAttributes,
  TextRenderable,
  type CliRenderer,
  type TextChunk,
} from "@opentui/core"
import { ToolCell } from "./tool-cell"
import { formatTimestamp } from "./text"
import { background, COLORS, textColors } from "./theme"

function formatReasoningSummary(content: string): StyledText {
  const chunks: TextChunk[] = []
  const foreground = textColors(COLORS.dim).fg
  let cursor = 0
  let strong = false

  while (cursor < content.length) {
    const marker = content.indexOf("**", cursor)
    const end = marker === -1 ? content.length : marker
    if (end > cursor) {
      chunks.push({
        __isChunk: true,
        text: content.slice(cursor, end),
        fg: foreground,
        attributes:
          TextAttributes.DIM | TextAttributes.ITALIC | (strong ? TextAttributes.BOLD : TextAttributes.NONE),
      })
    }
    if (marker === -1) break
    strong = !strong
    cursor = marker + 2
  }

  return new StyledText(chunks)
}

export class StreamingText {
  private buffer = ""

  constructor(private readonly update: (content: string) => void) {}

  append(delta: string): void {
    this.buffer += delta
    this.update(this.buffer)
  }
}

export class ChatLog {
  readonly view: ScrollBoxRenderable
  private readonly tools: ToolCell[] = []
  private toolsExpanded = false

  constructor(private readonly renderer: CliRenderer) {
    this.view = new ScrollBoxRenderable(renderer, {
      flexGrow: 1,
      stickyScroll: true,
      stickyStart: "bottom",
      paddingLeft: 2,
      paddingRight: 2,
      paddingTop: 0,
      viewportCulling: true,
      verticalScrollbarOptions: { visible: false },
      horizontalScrollbarOptions: { visible: false },
    })
  }

  addUser(text: string, sentAt: number): void {
    const box = new BoxRenderable(this.renderer, {
      flexDirection: "row",
      alignItems: "flex-start",
      minWidth: 0,
      marginTop: 1,
      padding: 1,
      ...background(COLORS.userBackground),
    })
    this.view.add(box)
    box.add(
      new TextRenderable(this.renderer, {
        content: text,
        flexGrow: 1,
        minWidth: 0,
        wrapMode: "word",
        ...textColors(COLORS.foreground, COLORS.userBackground),
      }),
    )
    box.add(
      new TextRenderable(this.renderer, {
        content: formatTimestamp(sentAt),
        height: 1,
        flexShrink: 0,
        marginLeft: 2,
        attributes: TextAttributes.DIM,
        wrapMode: "none",
        ...textColors(COLORS.foreground, COLORS.userBackground),
      }),
    )
  }

  addInfo(text: string): void {
    const box = this.cell()
    box.add(
      new TextRenderable(this.renderer, {
        content: text,
        attributes: TextAttributes.DIM,
        wrapMode: "word",
        ...textColors(),
      }),
    )
  }

  addError(text: string): void {
    const box = this.cell()
    box.add(
      new TextRenderable(this.renderer, {
        content: `x ${text}`,
        wrapMode: "word",
        ...textColors(COLORS.error),
      }),
    )
  }

  startAssistant(): StreamingText {
    const box = this.cell()
    const text = new TextRenderable(this.renderer, {
      content: "",
      wrapMode: "word",
      ...textColors(),
    })
    box.add(text)
    return new StreamingText((content) => {
      text.content = content
    })
  }

  startReasoningSummary(): StreamingText {
    const box = this.cell()
    const text = new TextRenderable(this.renderer, {
      content: "",
      wrapMode: "word",
      ...textColors(COLORS.dim),
    })
    box.add(text)
    return new StreamingText((content) => {
      text.content = formatReasoningSummary(content)
    })
  }

  addToolCell(tool: string, command: string): ToolCell {
    const box = this.cell(0)
    const cell = new ToolCell(this.renderer, tool, command, this.toolsExpanded)
    cell.addTo(box)
    this.tools.push(cell)
    return cell
  }

  toggleToolOutput(): void {
    this.toolsExpanded = !this.toolsExpanded
    for (const tool of this.tools) tool.setExpanded(this.toolsExpanded)
  }

  scrollPage(direction: -1 | 1): void {
    this.view.scrollBy(direction * 0.85, "viewport")
  }

  private cell(marginTop = 1): BoxRenderable {
    const box = new BoxRenderable(this.renderer, {
      flexDirection: "column",
      minWidth: 0,
      marginTop,
    })
    this.view.add(box)
    return box
  }
}
