import { bold, BoxRenderable, StyledText, TextRenderable, t, type CliRenderer } from "@opentui/core"
import { background, border, COLORS, muted, paint, textColors } from "./theme"

export interface PermissionPopoverActions {
  approve(): void
  deny(): void
  cancel(): void
}

export class PermissionPopover {
  readonly view: BoxRenderable
  private readonly command: TextRenderable
  private readonly options: TextRenderable
  private selection = 0

  get visible(): boolean {
    return this.view.visible
  }

  constructor(
    renderer: CliRenderer,
    private readonly actions: PermissionPopoverActions,
  ) {
    this.view = new BoxRenderable(renderer, {
      visible: false,
      height: 6,
      minWidth: 0,
      flexDirection: "column",
      border: true,
      borderStyle: "rounded",
      paddingLeft: 1,
      paddingRight: 1,
      marginLeft: 1,
      marginRight: 1,
      ...background(),
      ...border(COLORS.warning),
    })
    this.view.add(
      new TextRenderable(renderer, {
        content: t`${bold(paint(COLORS.warning, "Approve command?"))}`,
        height: 1,
        wrapMode: "none",
        truncate: true,
        ...textColors(),
      }),
    )
    this.command = new TextRenderable(renderer, {
      content: "",
      height: 1,
      wrapMode: "none",
      truncate: true,
      ...textColors(),
    })
    this.options = new TextRenderable(renderer, {
      content: "",
      height: 1,
      wrapMode: "none",
      truncate: true,
      ...textColors(),
    })
    this.view.add(this.command)
    this.view.add(this.options)
    this.view.add(
      new TextRenderable(renderer, {
        content: "←→ choose · Enter confirm · Esc cancel",
        height: 1,
        wrapMode: "none",
        truncate: true,
        ...textColors(COLORS.faint),
      }),
    )
    this.renderOptions()
  }

  show(command: string): void {
    this.selection = 0
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
      this.selection = this.selection === 0 ? 1 : 0
      this.renderOptions()
      return true
    }
    if (name === "y") {
      this.confirm(0)
      return true
    }
    if (name === "n") {
      this.confirm(1)
      return true
    }
    if (name === "return" || name === "enter") {
      this.confirm(this.selection)
      return true
    }
    if (name === "escape") {
      this.hide()
      this.actions.cancel()
      return true
    }
    return true
  }

  private confirm(selection: number): void {
    this.hide()
    if (selection === 0) this.actions.approve()
    else this.actions.deny()
  }

  private renderOptions(): void {
    const run = this.selection === 0 ? paint(COLORS.accent, "❯ [y] Run") : muted("  [y] Run")
    const deny = this.selection === 1 ? paint(COLORS.accent, "❯ [n] Deny") : muted("  [n] Deny")
    this.options.content = new StyledText([run, muted("  ·  "), deny])
  }
}
