import { bold, StyledText, t, type BoxRenderable, type CliRenderer, type TextRenderable } from "@opentui/core"
import { column, label } from "../lib/renderables"
import { COLORS } from "../theme/colors"
import { background, border, muted, paint } from "../theme/styles"

export interface PermissionPopoverActions {
  approve(): void
  deny(): void
  cancel(): void
}

type Choice = "run" | "deny"

export class PermissionPopover {
  readonly view: BoxRenderable
  private readonly command: TextRenderable
  private readonly options: TextRenderable
  private choice: Choice = "run"

  get visible(): boolean {
    return this.view.visible
  }

  constructor(
    renderer: CliRenderer,
    private readonly actions: PermissionPopoverActions,
  ) {
    this.view = column(renderer, {
      visible: false,
      height: 6,
      border: true,
      borderStyle: "rounded",
      paddingLeft: 1,
      paddingRight: 1,
      marginLeft: 1,
      marginRight: 1,
      ...background(),
      ...border(COLORS.warning),
    })
    this.command = label(renderer, { content: "" })
    this.options = label(renderer, { content: "" })

    this.view.add(label(renderer, { content: t`${bold(paint(COLORS.warning, "Approve command?"))}` }))
    this.view.add(this.command)
    this.view.add(this.options)
    this.view.add(label(renderer, { content: "←→ choose · Enter confirm · Esc cancel", color: COLORS.faint }))
    this.renderOptions()
  }

  show(command: string): void {
    this.choice = "run"
    this.command.content = t`${muted("$ ")}${paint(COLORS.foreground, command)}`
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
