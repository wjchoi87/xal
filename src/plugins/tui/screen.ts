import type { BoxRenderable, CliRenderer } from "@opentui/core"
import type { AgentSession } from "../../agent/agent-session"
import { runCommand } from "../../commands/run"
import type { CommandContext, SelectRequest } from "../../commands/types"
import { describeError } from "../../lib/error"
import { compactPath } from "../../lib/path"
import type { PermissionMode } from "../../permissions/types"
import type { ThinkingEffort, UserInput } from "../../providers/types"
import { CommandPalette, PALETTE_CHROME_ROWS } from "./components/command-palette"
import { Composer } from "./components/composer"
import { LiveTools } from "./components/live-tools"
import { Picker } from "./components/picker"
import { PermissionPopover, type PermissionPopoverActions } from "./components/permission-popover"
import { SecretInput } from "./components/secret-input"
import { StatusBar, STATUS_ROWS } from "./components/status-bar"
import { column } from "./lib/renderables"
import { Scrollback } from "./scrollback/scrollback"

export interface ScreenActions extends PermissionPopoverActions {
  submit(input: UserInput): boolean
}

const SCROLLBACK_GAP_ROWS = 1

export class Screen {
  readonly view: BoxRenderable
  readonly scrollback: Scrollback
  readonly live: LiveTools
  readonly permission: PermissionPopover
  readonly secret: SecretInput
  readonly picker: Picker
  readonly palette: CommandPalette
  readonly composer: Composer
  readonly statusBar: StatusBar
  private overlaid = false
  private paletteBelow = true
  private reserved = 0

  constructor(
    private readonly renderer: CliRenderer,
    private readonly session: AgentSession,
    startRow: number,
    actions: ScreenActions,
  ) {
    this.scrollback = new Scrollback(renderer, startRow, (rows) => this.reclaim(rows))
    this.view = column(renderer, { width: "100%", height: "100%", justifyContent: "flex-end" })
    this.live = new LiveTools(renderer, () => this.syncFooter())
    this.permission = new PermissionPopover(renderer, actions)
    this.secret = new SecretInput(renderer, () => this.syncFooter())
    this.picker = new Picker(renderer, () => this.syncFooter())
    this.palette = new CommandPalette(
      renderer,
      {
        complete: (line) => this.composer.setValue(line),
        run: (line) => this.runCommand(line),
      },
      () => this.syncFooter(),
    )
    this.composer = new Composer(renderer, {
      submit: (input) => {
        if (input.images.length === 0 || this.session.currentProvider.capabilities.imageInput) {
          return actions.submit(input)
        }
        this.scrollback.append({
          kind: "error",
          text: `${this.session.currentProvider.name} does not support image input`,
        })
        return false
      },
      run: (line) => this.runCommand(line),
      change: (value) => {
        this.placePalette()
        this.palette.update(value, this.paletteLimit())
      },
      resize: () => this.syncFooter(),
    })
    this.statusBar = new StatusBar(renderer, session.currentModel, session.currentThinking, session.currentMode)

    this.view.add(this.live.view)
    this.view.add(this.permission.view)
    this.view.add(this.secret.view)
    this.view.add(this.picker.view)
    this.view.add(this.composer.view)
    this.view.add(this.palette.view)
    this.view.add(this.statusBar.view)
    this.syncFooter()
  }

  get overlayVisible(): boolean {
    return this.permission.visible || this.secret.visible || this.picker.visible
  }

  requestApproval(suggestion: string | undefined): void {
    this.picker.hide()
    this.permission.show(suggestion)
    this.syncFooter()
  }

  dismissApproval(): void {
    this.permission.hide()
    this.syncFooter()
  }

  startSession(model: string, thinking: ThinkingEffort | undefined, mode: PermissionMode): void {
    this.statusBar.setModel(model)
    this.statusBar.setThinking(thinking)
    this.statusBar.setMode(mode)
    this.statusBar.resetUsage()
    this.scrollback.clear()
    this.scrollback.append({ kind: "banner", model, cwd: compactPath(process.cwd()) })
  }

  async select<T>(request: SelectRequest<T>): Promise<T | undefined> {
    const chosen = this.picker.show(request.options, request.search)
    this.syncFooter()
    const index = await chosen
    return index === undefined ? undefined : request.options[index]?.value
  }

  async askSecret(question: string): Promise<string | undefined> {
    this.picker.hide()
    return this.secret.show(question)
  }

  syncFooter(): void {
    const overlaid = this.overlayVisible
    if (overlaid !== this.overlaid) {
      this.overlaid = overlaid
      this.composer.setVisible(!overlaid)
      if (overlaid) {
        this.composer.blur()
        this.picker.focus()
      } else {
        this.picker.blur()
        this.composer.focus()
      }
    }
    if (overlaid) this.palette.hide()
    const paletteRows = this.palette.visible ? this.palette.height : 0
    if (this.paletteBelow || overlaid) this.reserved = 0
    else this.reserved = Math.max(this.reserved, paletteRows)
    const editing = this.composer.rows + Math.max(paletteRows, this.reserved)
    const overlayRows = this.permission.visible
      ? this.permission.height
      : this.secret.visible
        ? this.secret.height
        : this.picker.height
    this.renderer.footerHeight = this.live.height + (overlaid ? overlayRows : editing) + STATUS_ROWS
  }

  private reclaim(rows: number): void {
    if (this.reserved === 0) return
    this.reserved = Math.max(0, this.reserved - rows)
    this.syncFooter()
  }

  private closedFooterRows(): number {
    return this.live.height + this.composer.rows + STATUS_ROWS
  }

  private spaceBelowFooter(): number {
    const terminal = this.renderer.terminalHeight
    const footer = this.closedFooterRows()
    const content = this.scrollback.rows + SCROLLBACK_GAP_ROWS
    const top = Math.max(0, Math.min(content, terminal - footer))
    return Math.max(0, terminal - top - footer)
  }

  private paletteLimit(): number {
    const space = this.paletteBelow
      ? this.spaceBelowFooter()
      : Math.max(0, this.renderer.terminalHeight - this.closedFooterRows())
    return space - PALETTE_CHROME_ROWS
  }

  private placePalette(): void {
    const below = this.spaceBelowFooter() > PALETTE_CHROME_ROWS
    if (below === this.paletteBelow) return
    this.paletteBelow = below
    this.view.remove(this.palette.view)
    this.view.insertBefore(this.palette.view, below ? this.statusBar.view : this.composer.view)
    this.syncFooter()
  }

  private commandContext(): CommandContext {
    return {
      session: this.session,
      print: (text) => this.scrollback.append({ kind: "info", text }),
      busy: (label) => this.statusBar.setLoading(label),
      select: <T>(request: SelectRequest<T>) => this.select(request),
      askSecret: (question) => this.askSecret(question),
    }
  }

  private runCommand(line: string): void {
    this.palette.hide()
    this.composer.setValue("")
    runCommand(line, this.commandContext()).catch((error: unknown) => {
      this.statusBar.setLoading(undefined)
      this.scrollback.append({ kind: "error", text: describeError(error) })
    })
    this.syncFooter()
  }
}
