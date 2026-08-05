import { StyledText, TextAttributes, type BoxRenderable, type RenderContext, type TextRenderable } from "@opentui/core"
import { label, row } from "../lib/renderables"
import { COLORS } from "../theme/colors"
import { background, border, muted, paint } from "../theme/styles"

export const POPOVER_ROWS = 4

export interface PermissionPopoverActions {
  approve(): void
  deny(): void
  cancel(): void
}

type Choice = "run" | "deny"

export class PermissionPopover {
  readonly view: BoxRenderable
  private readonly options: TextRenderable
  private choice: Choice = "run"

  get visible(): boolean {
    return this.view.visible
  }

  constructor(
    ctx: RenderContext,
    private readonly actions: PermissionPopoverActions,
  ) {
    this.view = row(ctx, {
      visible: false,
      height: 3,
      alignItems: "center",
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
    this.options = label(ctx, { content: "", flexGrow: 1, flexShrink: 1, minWidth: 1 })

    this.view.add(label(ctx, { content: "?", width: 2, attributes: TextAttributes.BOLD, color: COLORS.warning }))
    this.view.add(this.options)
    this.view.add(label(ctx, { content: "←→ · Enter · Esc", flexShrink: 0, marginLeft: 1, color: COLORS.faint }))
    this.renderOptions()
  }

  show(): void {
    this.choice = "run"
    this.renderOptions()
    this.view.visible = true
  }

  hide(): void {
    this.view.visible = false
  }

  handleKey(name: string): boolean {
    if (!this.view.visible) return false
    if (name === "left" || name === "right" || name === "up" || name === "down") {
      this.choice = this.choice === "run" ? "deny" : "run"
      this.renderOptions()
      return true
    }
    if (name === "y") {
      this.confirm("run")
      return true
    }
    if (name === "n") {
      this.confirm("deny")
      return true
    }
    if (name === "return" || name === "enter") {
      this.confirm(this.choice)
      return true
    }
    if (name === "escape") {
      this.hide()
      this.actions.cancel()
      return true
    }
    return true
  }

  private confirm(choice: Choice): void {
    this.hide()
    if (choice === "run") this.actions.approve()
    else this.actions.deny()
  }

  private renderOptions(): void {
    const option = (choice: Choice, text: string) =>
      this.choice === choice ? paint(COLORS.accent, `❯ ${text}`) : muted(`  ${text}`)
    this.options.content = new StyledText([option("run", "[y] Run"), muted("  ·  "), option("deny", "[n] Deny")])
  }
}
