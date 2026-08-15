import { clear, el } from "./dom.ts"

export type PermissionChoice = { key: string; text: string; allow: boolean }

export function approvalFor(choices: PermissionChoice[]): PermissionChoice {
  const allowed = choices.find((choice) => choice.allow)
  if (!allowed) throw new Error("permission request without an allowing choice")
  return allowed
}

export class Permission {
  readonly view = el("div", "block box box-warning permission")
  private readonly options = el("div", "permission-options")
  private choices: PermissionChoice[] = []
  private selected = 0
  private resolve: ((choice: PermissionChoice) => void) | undefined

  constructor() {
    this.view.hidden = true
    const row = el("div", "permission-row")
    row.append(el("span", "permission-badge", "?"))
    row.append(this.options)
    row.append(el("span", "permission-hint", "↑↓ · Enter · Esc"))
    this.view.append(row)
  }

  get open(): boolean {
    return this.resolve !== undefined
  }

  ask(choices: PermissionChoice[]): Promise<PermissionChoice> {
    this.choices = choices
    this.selected = 0
    this.view.hidden = false
    this.render()
    return new Promise((resolve) => {
      this.resolve = resolve
    })
  }

  handleKey(event: KeyboardEvent): boolean {
    if (!this.open) return false
    const key = event.key.toLowerCase()
    const direct = this.choices.find((choice) => choice.key === key)
    if (direct) {
      event.preventDefault()
      this.settle(direct)
      return true
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      const delta = event.key === "ArrowDown" ? 1 : -1
      this.selected = (this.selected + delta + this.choices.length) % this.choices.length
      this.render()
      return true
    }
    if (event.key === "Enter" || event.key === "Escape") {
      event.preventDefault()
      const fallback = this.choices[this.choices.length - 1]
      const choice = event.key === "Enter" ? this.choices[this.selected] : fallback
      if (choice) this.settle(choice)
      return true
    }
    return false
  }

  private settle(choice: PermissionChoice): void {
    const resolve = this.resolve
    this.resolve = undefined
    this.view.hidden = true
    resolve?.(choice)
  }

  private render(): void {
    clear(this.options)
    this.choices.forEach((choice, index) => {
      const row = el("button", `permission-option${index === this.selected ? " selected" : ""}`)
      row.type = "button"
      row.append(el("span", "permission-glyph", index === this.selected ? "❯" : ""))
      row.append(el("span", "permission-text", `[${choice.key}] ${choice.text}`))
      row.addEventListener("click", () => this.settle(choice))
      row.addEventListener("mouseenter", () => {
        this.selected = index
        this.render()
      })
      this.options.append(row)
    })
  }
}
