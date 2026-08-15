import { el } from "./dom.ts"

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
const CONTEXT_WINDOW = 200_000

export type Activity =
  { kind: "idle" } | { kind: "working" } | { kind: "finished"; elapsed: string } | { kind: "approval" }

export class StatusBar {
  readonly view = el("div", "status-bar")
  private readonly left = el("div", "status-left")
  private readonly right = el("div", "status-right")
  private readonly meta = el("span", "meta faint")
  private readonly mode = el("span", "acc")
  private activity: Activity = { kind: "idle" }
  private hint: string | undefined
  private frame = 0
  private tokens = 12_400

  constructor(
    private readonly model: string,
    private readonly thinking: string,
  ) {
    this.right.append(this.meta)
    this.right.append(this.mode)
    this.view.append(this.left)
    this.view.append(this.right)
    this.mode.textContent = " · normal"
    this.renderMeta()
    this.renderLeft()
    setInterval(() => {
      this.frame = (this.frame + 1) % SPINNER.length
      if (this.activity.kind === "working") this.renderLeft()
    }, 100)
  }

  setHint(hint: string | undefined): void {
    this.hint = hint
    this.renderLeft()
  }

  setActivity(activity: Activity): void {
    this.activity = activity
    this.renderLeft()
  }

  addTokens(amount: number): void {
    this.tokens += amount
    this.renderMeta()
  }

  resetTokens(): void {
    this.tokens = 12_400
    this.renderMeta()
  }

  private renderMeta(): void {
    const share = Math.round((this.tokens / CONTEXT_WINDOW) * 100)
    this.meta.textContent = `${this.model} · ${this.thinking} · ${formatTokens(this.tokens)} (${share}%) `
  }

  private renderLeft(): void {
    this.left.replaceChildren()
    if (this.hint) {
      this.left.append(el("span", "dim", this.hint))
      return
    }
    if (this.activity.kind === "working") {
      this.left.append(el("span", "spinner", SPINNER[this.frame] ?? "⠋"))
      this.left.append(el("span", "dim", " Working · Esc interrupt"))
      return
    }
    if (this.activity.kind === "approval") {
      this.left.append(el("span", "warn", "!"))
      this.left.append(el("span", "dim", " Approval needed · choose above"))
      return
    }
    if (this.activity.kind === "finished") {
      this.left.append(el("span", "ok", "✓"))
      this.left.append(el("span", "dim", ` Finished in ${this.activity.elapsed}`))
    }
  }
}

function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens)
  const thousands = tokens / 1000
  if (thousands >= 99.95) return `${Math.round(thousands)}K`
  return `${thousands.toFixed(1)}K`
}
