import { el } from "./dom.ts"
import { Palette, type Entry } from "./palette.ts"

export class Composer {
  readonly view = el("div", "composer-dock")
  readonly input = el("input", "composer-input")
  private readonly box = el("div", "composer")
  private readonly prompt = el("span", "composer-prompt", "❯")
  private readonly palette: Palette
  private readonly history: string[] = []
  private historyIndex = 0

  constructor(
    private readonly entries: Entry[],
    private readonly onSubmit: (value: string) => void,
    private readonly onPaletteToggle: (open: boolean) => void,
  ) {
    this.palette = new Palette((entry) => this.accept(entry))
    this.input.type = "text"
    this.input.autocomplete = "off"
    this.input.spellcheck = false
    this.input.setAttribute("aria-label", "command input")
    this.input.placeholder = "type / for commands"

    this.box.append(this.prompt)
    this.box.append(this.input)
    this.view.append(this.palette.view)
    this.view.append(this.box)

    this.input.addEventListener("input", () => this.refresh())
    this.input.addEventListener("keydown", (event) => this.onKey(event))
  }

  focus(): void {
    this.input.focus()
  }

  setEnabled(enabled: boolean): void {
    this.box.classList.toggle("disabled", !enabled)
    this.input.disabled = !enabled
    if (enabled) this.focus()
  }

  private accept(entry: Entry): void {
    this.input.value = ""
    this.refresh()
    this.submit(entry.name)
  }

  private refresh(): void {
    const value = this.input.value.trim().toLowerCase()
    const matches = value.startsWith("/") ? this.entries.filter((entry) => entry.name.startsWith(value)) : []
    if (matches.length > 0) this.palette.show(matches)
    else this.palette.hide()
    this.box.classList.toggle("active", this.palette.open)
    this.onPaletteToggle(this.palette.open)
  }

  private submit(value: string): void {
    const trimmed = value.trim()
    if (!trimmed) return
    this.history.push(trimmed)
    this.historyIndex = this.history.length
    this.onSubmit(trimmed)
  }

  private onKey(event: KeyboardEvent): void {
    if (this.palette.open) {
      if (event.key === "ArrowDown" || (event.key === "Tab" && !event.shiftKey)) {
        event.preventDefault()
        this.palette.move(1)
        return
      }
      if (event.key === "ArrowUp" || (event.key === "Tab" && event.shiftKey)) {
        event.preventDefault()
        this.palette.move(-1)
        return
      }
      if (event.key === "Enter") {
        event.preventDefault()
        this.palette.commit()
        return
      }
      if (event.key === "Escape") {
        event.preventDefault()
        this.input.value = ""
        this.refresh()
        return
      }
    }

    if (event.key === "Enter") {
      event.preventDefault()
      const value = this.input.value
      this.input.value = ""
      this.refresh()
      this.submit(value)
      return
    }
    if (event.key === "ArrowUp") {
      event.preventDefault()
      this.recall(-1)
      return
    }
    if (event.key === "ArrowDown") {
      event.preventDefault()
      this.recall(1)
      return
    }
    if (event.key === "Escape") {
      event.preventDefault()
      this.input.value = ""
      this.refresh()
    }
  }

  private recall(delta: number): void {
    if (this.history.length === 0) return
    this.historyIndex = Math.min(this.history.length, Math.max(0, this.historyIndex + delta))
    this.input.value = this.history[this.historyIndex] ?? ""
    this.refresh()
  }
}
