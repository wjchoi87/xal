import { ScrollBoxRenderable, type BoxRenderable, type CliRenderer, type Renderable } from "@opentui/core"
import { column } from "../lib/renderables"
import {
  assistantEntry,
  collapsibleEntry,
  errorEntry,
  infoEntry,
  reasoningEntry,
  userEntry,
  type Collapsible,
} from "./chat-entries"
import type { StreamingText } from "./streaming-text"
import { ToolCell } from "./tool-cell"

export class ChatLog {
  readonly view: ScrollBoxRenderable
  private readonly collapsibles: Collapsible[] = []
  private expanded = false

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
    this.append(userEntry(this.renderer, text, sentAt))
  }

  addInfo(text: string): void {
    this.append(infoEntry(this.renderer, text))
  }

  addError(text: string): void {
    this.append(errorEntry(this.renderer, text))
  }

  startAssistant(): StreamingText {
    const entry = assistantEntry(this.renderer)
    this.append(entry.view)
    return entry.stream
  }

  startReasoningSummary(): StreamingText {
    const entry = reasoningEntry(this.renderer)
    this.append(entry.view)
    return entry.stream
  }

  addCollapsible(summary: string, details: string[]): void {
    const entry = collapsibleEntry(this.renderer, summary, details, this.expanded)
    this.append(entry.view)
    this.collapsibles.push(entry.collapsible)
  }

  addToolCell(tool: string, command: string, readOnly: boolean): ToolCell {
    const container = this.container(0)
    const cell = new ToolCell(this.renderer, tool, command, readOnly, this.expanded)
    cell.addTo(container)
    this.collapsibles.push(cell)
    return cell
  }

  toggleToolOutput(): void {
    this.expanded = !this.expanded
    for (const collapsible of this.collapsibles) collapsible.setExpanded(this.expanded)
  }

  scrollPage(direction: -1 | 1): void {
    this.view.scrollBy(direction * 0.85, "viewport")
  }

  private append(child: Renderable): void {
    this.container(1).add(child)
  }

  private container(marginTop: number): BoxRenderable {
    const box = column(this.renderer, { marginTop })
    this.view.add(box)
    return box
  }
}
