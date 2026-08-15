import { renderBlock, type Block } from "./blocks.ts"
import { clear, el, reducedMotion } from "./dom.ts"

export class Scrollback {
  readonly view: HTMLElement
  private readonly stream: HTMLElement
  private previous: Block["kind"] | undefined
  private autoScroll = false

  constructor(existing?: HTMLElement) {
    if (existing) {
      this.stream = existing
      const parent = existing.parentElement
      if (!parent) throw new Error("adopted stream is not attached")
      this.view = parent
      return
    }
    this.view = el("div", "scrollback")
    this.stream = el("div", "stream")
    this.view.append(this.stream)
  }

  append(block: Block): void {
    const node = renderBlock(block)
    if (!reducedMotion()) node.classList.add("entering")
    if (block.kind === "tool" && this.previous === "tool") node.classList.add("glued")
    this.stream.append(node)
    this.previous = block.kind
    if (this.autoScroll) this.scrollToEnd()
  }

  attach(node: HTMLElement): void {
    this.stream.append(node)
    this.previous = undefined
    if (this.autoScroll) this.scrollToEnd()
  }

  replaceLast(block: Block): void {
    this.stream.lastElementChild?.remove()
    this.previous = undefined
    this.append(block)
  }

  reset(): void {
    clear(this.stream)
    this.previous = undefined
  }

  setAutoScroll(enabled: boolean): void {
    this.autoScroll = enabled
  }

  private scrollToEnd(): void {
    this.view.scrollTop = this.view.scrollHeight
  }
}
