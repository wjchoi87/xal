import { StyledText, TextAttributes, type BoxRenderable, type RenderContext, type TextRenderable } from "@opentui/core"
import type { PermissionScope } from "../../../permissions/types"
import { column, label, row } from "../lib/renderables"
import { COLORS } from "../theme/colors"
import { background, border, muted, paint } from "../theme/styles"

export interface PermissionPopoverActions {
  approve(scope: PermissionScope, pattern?: string): void
  deny(): void
  cancel(): void
}

interface Choice {
  key: string
  text: string
  scope: PermissionScope | undefined
}

export class PermissionPopover {
  readonly view: BoxRenderable
  private readonly options: BoxRenderable
  private readonly rows: TextRenderable[] = []
  private choices: Choice[] = []
  private selected = 0
  private suggestion: string | undefined

  get visible(): boolean {
    return this.view.visible
  }

  get height(): number {
    return this.choices.length + 3
  }

  constructor(
    ctx: RenderContext,
    private readonly actions: PermissionPopoverActions,
  ) {
    this.view = row(ctx, {
      visible: false,
      border: true,
      borderStyle: "rounded",
      paddingLeft: 1,
      paddingRight: 1,
      marginLeft: 1,
      marginRight: 1,
      marginTop: 1,
      ...background(),
      ...border(COLORS.warning),
    })
    this.options = column(ctx, { flexGrow: 1, flexShrink: 1, minWidth: 1 })

    this.view.add(label(ctx, { content: "?", width: 2, attributes: TextAttributes.BOLD, color: COLORS.warning }))
    this.view.add(this.options)
    this.view.add(label(ctx, { content: "↑↓ · Enter · Esc", flexShrink: 0, marginLeft: 1, color: COLORS.faint }))

    for (let index = 0; index < 4; index++) {
      const line = label(ctx, { content: "" })
      this.rows.push(line)
      this.options.add(line)
    }
  }

  show(suggestion: string | undefined): void {
    this.suggestion = suggestion
    this.choices = [{ key: "y", text: "Allow once", scope: "once" }]
    if (suggestion) {
      this.choices.push(
        { key: "s", text: `Allow ${suggestion} this session`, scope: "session" },
        { key: "a", text: `Always allow ${suggestion}`, scope: "always" },
      )
    }
    this.choices.push({ key: "n", text: "Deny", scope: undefined })
    this.selected = 0
    this.renderOptions()
    this.view.height = this.choices.length + 2
    this.view.visible = true
  }

  hide(): void {
    this.view.visible = false
  }

  handleKey(name: string): boolean {
    if (!this.view.visible) return false
    if (name === "up") {
      this.move(-1)
      return true
    }
    if (name === "down") {
      this.move(1)
      return true
    }
    if (name === "escape") {
      this.hide()
      this.actions.cancel()
      return true
    }
    const shortcut = this.choices.find((choice) => choice.key === name)
    if (shortcut) {
      this.confirm(shortcut)
      return true
    }
    if (name === "return" || name === "enter") this.confirm(this.choices[this.selected])
    return true
  }

  private move(delta: number): void {
    const count = this.choices.length
    this.selected = (this.selected + delta + count) % count
    this.renderOptions()
  }

  private confirm(choice: Choice | undefined): void {
    if (!choice) return
    this.hide()
    if (!choice.scope) {
      this.actions.deny()
      return
    }
    this.actions.approve(choice.scope, choice.scope === "once" ? undefined : this.suggestion)
  }

  private renderOptions(): void {
    this.rows.forEach((line, index) => {
      const choice = this.choices[index]
      if (!choice) {
        line.content = new StyledText([muted("")])
        line.visible = false
        return
      }
      line.visible = true
      const text = `[${choice.key}] ${choice.text}`
      line.content = new StyledText([index === this.selected ? paint(COLORS.accent, `❯ ${text}`) : muted(`  ${text}`)])
    })
  }
}
