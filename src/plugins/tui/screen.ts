import type { BoxRenderable, CliRenderer } from "@opentui/core"
import { ChatLog } from "./components/chat-log"
import { Composer } from "./components/composer"
import { PermissionPopover, type PermissionPopoverActions } from "./components/permission-popover"
import { StatusBar } from "./components/status-bar"
import { column } from "./lib/renderables"

export interface ScreenActions extends PermissionPopoverActions {
  submit(text: string): boolean
}

export class Screen {
  readonly root: BoxRenderable
  readonly chatLog: ChatLog
  readonly permission: PermissionPopover
  readonly composer: Composer
  readonly statusBar: StatusBar

  constructor(renderer: CliRenderer, model: string, actions: ScreenActions) {
    this.root = column(renderer, { width: "100%", height: "100%" })
    this.chatLog = new ChatLog(renderer)
    this.permission = new PermissionPopover(renderer, actions)
    this.composer = new Composer(renderer, (text) => actions.submit(text))
    this.statusBar = new StatusBar(renderer, model)

    this.root.add(this.chatLog.view)
    this.root.add(this.permission.view)
    this.root.add(this.composer.view)
    this.root.add(this.statusBar.view)
  }

  requestApproval(title: string): void {
    this.permission.show(title)
    this.composer.setPopoverVisible(true)
  }

  dismissApproval(): void {
    this.permission.hide()
    this.composer.setPopoverVisible(false)
  }

  syncApproval(): void {
    this.composer.setPopoverVisible(this.permission.visible)
  }
}
