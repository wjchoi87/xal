import { clear, el } from "./dom.ts"

export type Entry = { name: string; description: string }

export class Palette {
  readonly view = el("div", "palette")
  private entries: Entry[] = []
  private selected = 0

  constructor(private readonly onPick: (entry: Entry) => void) {
    this.view.hidden = true
  }

  get open(): boolean {
    return this.entries.length > 0
  }

  show(entries: Entry[]): void {
    this.entries = entries
    this.selected = 0
    this.render()
  }

  hide(): void {
    this.entries = []
    this.render()
  }

  move(delta: number): void {
    if (!this.open) return
    this.selected = (this.selected + delta + this.entries.length) % this.entries.length
    this.render()
  }

  commit(): boolean {
    const entry = this.entries[this.selected]
    if (!entry) return false
    this.hide()
    this.onPick(entry)
    return true
  }

  private render(): void {
    clear(this.view)
    this.view.hidden = !this.open
    this.entries.forEach((entry, index) => {
      const row = el("div", `palette-row${index === this.selected ? " selected" : ""}`)
      row.append(el("span", "palette-glyph", index === this.selected ? "❯" : ""))
      row.append(el("span", "palette-name", entry.name))
      row.append(el("span", "palette-description", entry.description))
      row.addEventListener("mousedown", (event) => {
        event.preventDefault()
        this.selected = index
        this.commit()
      })
      this.view.append(row)
    })
    this.revealSelected()
  }

  private revealSelected(): void {
    const row = this.view.children[this.selected]
    if (row instanceof HTMLElement) row.scrollIntoView({ block: "nearest" })
  }
}
