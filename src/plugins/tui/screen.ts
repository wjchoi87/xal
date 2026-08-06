import type { BoxRenderable, CliRenderer } from "@opentui/core"
import type { PermissionMode } from "../../permissions/types"
import { Composer, COMPOSER_ROWS } from "./components/composer"
import { LiveTools } from "./components/live-tools"
import { PermissionPopover, type PermissionPopoverActions } from "./components/permission-popover"
import { StatusBar, STATUS_ROWS } from "./components/status-bar"
import { column } from "./lib/renderables"
import { Scrollback } from "./scrollback/scrollback"

export interface ScreenActions extends PermissionPopoverActions {
  submit(text: string): boolean
}

export class Screen {
  readonly view: BoxRenderable
  readonly scrollback: Scrollback
  readonly live: LiveTools
  readonly permission: PermissionPopover
  readonly composer: Composer
  readonly statusBar: StatusBar
  private approving = false

  constructor(
    private readonly renderer: CliRenderer,
    model: string,
    mode: PermissionMode,
    actions: ScreenActions,
  ) {
    this.scrollback = new Scrollback(renderer)
    this.view = column(renderer, { width: "100%", height: "100%" })
    this.live = new LiveTools(renderer, () => this.syncFooter())
    this.permission = new PermissionPopover(renderer, actions)
    this.composer = new Composer(renderer, (text) => actions.submit(text))
    this.statusBar = new StatusBar(renderer, model, mode)

    this.view.add(this.live.view)
    this.view.add(this.permission.view)
    this.view.add(this.composer.view)
    this.view.add(this.statusBar.view)
    this.syncFooter()
  }

  requestApproval(suggestion: string | undefined): void {
    this.permission.show(suggestion)
    this.syncFooter()
  }

  dismissApproval(): void {
    this.permission.hide()
    this.syncFooter()
  }

  syncFooter(): void {
    const approving = this.permission.visible
    if (approving !== this.approving) {
      this.approving = approving
      this.composer.setVisible(!approving)
      if (approving) this.composer.blur()
      else this.composer.focus()
    }
    this.renderer.footerHeight = this.live.height + (approving ? this.permission.height : COMPOSER_ROWS) + STATUS_ROWS
  }
}
