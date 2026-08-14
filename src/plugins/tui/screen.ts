import type { BoxRenderable, CliRenderer } from "@opentui/core"
import type { AgentSession } from "../../agent/agent-session"
import type { BackgroundAgentTask } from "../../background/registry"
import { runCommand } from "../../commands/run"
import type { CommandContext, SelectRequest } from "../../commands/types"
import { describeError } from "../../lib/error"
import { compactPath } from "../../lib/path"
import type { PermissionMode } from "../../permissions/types"
import type { ThinkingEffort, UserInput } from "../../providers/types"
import { protectSecretValue, redactText } from "../../secrets/redactor"
import type { ElicitationQuestion } from "../../tools/types"
import { AgentSummary } from "./components/agent-summary"
import { AgentViewer } from "./components/agent-viewer"
import { BackgroundTasks } from "./components/background-tasks"
import { Composer } from "./components/composer"
import { ConfigPopover } from "./components/config-popover"
import { CompletionPalette, PALETTE_CHROME_ROWS } from "./components/completion-palette"
import { ElicitationPopover, type ElicitationPopoverActions } from "./components/elicitation-popover"
import { LiveTools } from "./components/live-tools"
import { Picker } from "./components/picker"
import { PermissionPopover, type PermissionPopoverActions } from "./components/permission-popover"
import { QueuedInputs } from "./components/queued-inputs"
import { SecretInput } from "./components/secret-input"
import { ShortcutHelp } from "./components/shortcut-help"
import { StatusBar, STATUS_ROWS } from "./components/status-bar"
import { TaskList } from "./components/task-list"
import { saveTuiConfig, type TuiConfig } from "./config"
import { column } from "./lib/renderables"
import type { MessageHistory } from "./message-history"
import { Scrollback } from "./scrollback/scrollback"
import { sessionTerminalTitle } from "./terminal"

export interface ScreenActions extends PermissionPopoverActions, ElicitationPopoverActions {
  submit(input: UserInput): boolean
}

const SCROLLBACK_GAP_ROWS = 1

export class Screen {
  readonly view: BoxRenderable
  private readonly mainPanel: BoxRenderable
  readonly scrollback: Scrollback
  readonly agentSummary: AgentSummary
  readonly agentViewer: AgentViewer
  readonly live: LiveTools
  readonly queued: QueuedInputs
  readonly permission: PermissionPopover
  readonly elicitation: ElicitationPopover
  readonly secret: SecretInput
  readonly picker: Picker
  readonly config: ConfigPopover
  readonly palette: CompletionPalette
  readonly composer: Composer
  readonly statusBar: StatusBar
  readonly tasks: BackgroundTasks
  readonly taskList: TaskList
  private readonly shortcutHelp: ShortcutHelp
  private overlaid = false
  private paletteBelow = true
  private reserved = 0
  private agentActivityDirty = false
  private agentReplayPending = false
  private sessionTitle: string | undefined
  private cwd: string

  constructor(
    private readonly renderer: CliRenderer,
    private readonly session: AgentSession,
    startRow: number,
    private readonly history: MessageHistory,
    preferences: TuiConfig,
    actions: ScreenActions,
  ) {
    this.cwd = redactText(session.currentWorkingDirectory)
    this.scrollback = new Scrollback(renderer, startRow, (rows) => this.reclaim(rows), preferences)
    this.view = column(renderer, { width: "100%", height: "100%", justifyContent: "flex-end" })
    this.agentSummary = new AgentSummary(renderer, () => {
      if (this.agentSummary.height > 0) this.agentActivityDirty = true
      this.syncFooter()
    })
    this.agentViewer = new AgentViewer(renderer)
    this.live = new LiveTools(renderer, () => this.syncFooter())
    this.queued = new QueuedInputs(renderer, () => this.syncFooter())
    this.taskList = new TaskList(renderer, () => this.syncFooter())
    this.permission = new PermissionPopover(renderer, actions)
    this.elicitation = new ElicitationPopover(
      renderer,
      actions,
      () => this.syncFooter(),
      () => this.elicitationAvailableHeight(),
    )
    this.secret = new SecretInput(renderer, () => this.syncFooter())
    this.picker = new Picker(renderer, () => this.syncFooter())
    this.config = new ConfigPopover(renderer, preferences, {
      change: async (config, key) => {
        await saveTuiConfig(config)
        if (key === "showOutputs") {
          this.scrollback.setExpanded(config.showOutputs)
          return
        }
        this.scrollback.setReasoningVisible(config.showThinking)
      },
      changed: () => this.syncFooter(),
      error: (message) => this.scrollback.append({ kind: "error", text: message }),
    })
    this.palette = new CompletionPalette(
      renderer,
      {
        completeCommand: (line) => this.composer.setValue(line),
        completeSkill: (query, name, trailingSpace) => this.composer.completeSkill(query, name, trailingSpace),
        runCommand: (line) => this.runCommand(line),
      },
      () => this.syncFooter(),
    )
    this.statusBar = new StatusBar(renderer, session.currentModel, session.currentThinking, session.currentMode)
    this.shortcutHelp = new ShortcutHelp(renderer, () => this.syncFooter())
    this.composer = new Composer(renderer, history, {
      submit: (input) => {
        if (input.images.length === 0 || this.session.supportsImageInput) {
          return actions.submit(input)
        }
        this.scrollback.append({
          kind: "error",
          text: `${this.session.currentModel} does not support image input`,
        })
        return false
      },
      run: (line) => this.runCommand(line),
      error: (message) => this.scrollback.append({ kind: "error", text: message }),
      change: (value, cursor) => {
        const help = value.startsWith("?")
        if (this.shortcutHelp.setActive(help)) this.syncFooter()
        if (help) {
          this.palette.hide()
          return
        }
        this.placePalette()
        this.palette.update(value, cursor, this.paletteLimit())
      },
      resize: () => this.syncFooter(),
    })
    this.tasks = new BackgroundTasks(renderer, {
      changed: () => {
        this.agentViewer.refresh()
        this.syncFooter()
      },
      released: () => {
        if (!this.overlayVisible) this.composer.focus()
      },
      viewAgent: (task) => this.viewAgent(task),
      error: (message) => this.scrollback.append({ kind: "error", text: message }),
    })

    this.mainPanel = column(renderer, { paddingLeft: 2, paddingRight: 2 })
    this.mainPanel.add(this.agentSummary.view)
    this.mainPanel.add(this.live.view)
    this.mainPanel.add(this.queued.view)
    this.mainPanel.add(this.taskList.view)
    this.view.add(this.mainPanel)
    this.view.add(this.permission.view)
    this.view.add(this.elicitation.view)
    this.view.add(this.secret.view)
    this.view.add(this.picker.view)
    this.view.add(this.config.view)
    this.view.add(this.agentViewer.view)
    this.view.add(this.composer.view)
    this.view.add(this.shortcutHelp.view)
    this.view.add(this.palette.view)
    this.view.add(this.statusBar.view)
    this.view.add(this.tasks.view)
    this.syncFooter()
  }

  get overlayVisible(): boolean {
    return (
      this.permission.visible ||
      this.elicitation.visible ||
      this.secret.visible ||
      this.picker.visible ||
      this.config.visible
    )
  }

  requestApproval(suggestion: string | undefined): void {
    this.config.hide()
    this.picker.hide()
    this.permission.show(suggestion)
    this.syncFooter()
  }

  dismissApproval(): void {
    this.permission.hide()
    this.syncFooter()
  }

  requestElicitation(requestId: string, questions: ElicitationQuestion[]): void {
    this.config.hide()
    this.picker.hide()
    this.elicitation.show(requestId, questions)
    this.syncFooter()
  }

  dismissElicitation(): void {
    this.elicitation.hide()
    this.syncFooter()
  }

  startSession(
    title: string | undefined,
    cwd: string,
    model: string,
    thinking: ThinkingEffort | undefined,
    mode: PermissionMode,
  ): void {
    this.cwd = redactText(cwd)
    this.setSessionTitle(title)
    this.statusBar.setModel(model)
    this.statusBar.setThinking(thinking)
    this.statusBar.setMode(mode)
    this.statusBar.resetUsage()
    this.statusBar.resetTurnElapsed()
    this.taskList.set([])
    this.agentActivityDirty = false
    this.agentReplayPending = false
    this.viewAgent(undefined)
    this.scrollback.clear()
    this.scrollback.append({ kind: "banner", model, cwd: compactPath(cwd) })
  }

  setSessionTitle(title: string | undefined): void {
    this.sessionTitle = title === undefined ? undefined : redactText(title)
    this.renderer.setTerminalTitle(sessionTerminalTitle(this.sessionTitle, this.cwd))
  }

  setWorkingDirectory(cwd: string): void {
    this.cwd = redactText(cwd)
    this.renderer.setTerminalTitle(sessionTerminalTitle(this.sessionTitle, this.cwd))
  }

  async select<T>(request: SelectRequest<T>): Promise<T | undefined> {
    this.config.hide()
    const options = request.options.map((option) => ({
      ...option,
      label: redactText(option.label),
      detail: redactText(option.detail),
      ...(option.note === undefined ? {} : { note: redactText(option.note) }),
    }))
    const chosen = this.picker.show(options, request.search ? redactText(request.search) : undefined)
    this.syncFooter()
    const index = await chosen
    return index === undefined ? undefined : options[index]?.value
  }

  async askSecret(question: string): Promise<string | undefined> {
    this.config.hide()
    this.picker.hide()
    const value = await this.secret.show(redactText(question))
    if (value !== undefined) protectSecretValue(value)
    return value
  }

  openHistory(): void {
    this.palette.hide()
    this.executeCommand("/history")
    this.syncFooter()
  }

  openConfig(): void {
    this.picker.hide()
    this.config.show()
    this.syncFooter()
  }

  settleAgentActivity(): void {
    if (!this.agentActivityDirty) return
    this.agentActivityDirty = false
    if (this.agentViewer.visible) {
      this.agentReplayPending = true
      return
    }
    this.replayAgentActivity()
  }

  private replayAgentActivity(): void {
    queueMicrotask(() => {
      if (this.agentViewer.visible) {
        this.agentReplayPending = true
        return
      }
      this.syncFooter()
      this.scrollback.replay()
    })
  }

  private elicitationAvailableHeight(): number {
    const siblingRows = this.agentViewer.visible
      ? STATUS_ROWS + this.tasks.height
      : this.agentSummary.height +
        this.live.height +
        this.queued.height +
        this.taskList.height +
        STATUS_ROWS +
        this.tasks.height
    return Math.max(1, this.renderer.terminalHeight - siblingRows)
  }

  syncFooter(): void {
    const overlaid = this.overlayVisible
    this.shortcutHelp.setCovered(overlaid)
    if (overlaid !== this.overlaid) {
      this.overlaid = overlaid
      this.composer.setVisible(!overlaid)
      if (overlaid) {
        this.tasks.blur()
        this.composer.blur()
        this.elicitation.focus()
        this.picker.focus()
      } else {
        this.elicitation.blur()
        this.picker.blur()
        this.composer.focus()
      }
    }
    if (overlaid) this.palette.hide()
    this.statusBar.setHint(this.palette.visible ? "↑↓ · Tab · Enter · Esc" : undefined)
    this.elicitation.fit()
    const overlayRows = this.permission.visible
      ? this.permission.height
      : this.elicitation.visible
        ? this.elicitation.height
        : this.secret.visible
          ? this.secret.height
          : this.picker.visible
            ? this.picker.height
            : this.config.height
    if (this.agentViewer.visible) {
      this.palette.hide()
      this.reserved = 0
      const chrome =
        (overlaid ? overlayRows : this.composer.rows + this.shortcutHelp.height) + STATUS_ROWS + this.tasks.height
      this.agentViewer.resize(this.renderer.terminalHeight - chrome)
      this.renderer.footerHeight = this.agentViewer.height + chrome
      return
    }
    const paletteRows = this.palette.visible ? this.palette.height : 0
    if (this.paletteBelow || overlaid) this.reserved = 0
    else this.reserved = Math.max(this.reserved, paletteRows)
    const editing = this.composer.rows + this.shortcutHelp.height + Math.max(paletteRows, this.reserved)
    this.renderer.footerHeight =
      this.agentSummary.height +
      this.live.height +
      this.queued.height +
      this.taskList.height +
      (overlaid ? overlayRows : editing) +
      STATUS_ROWS +
      this.tasks.height
  }

  private reclaim(rows: number): void {
    if (this.reserved === 0) return
    this.reserved = Math.max(0, this.reserved - rows)
    this.syncFooter()
  }

  private closedFooterRows(): number {
    if (this.agentViewer.visible) {
      return this.agentViewer.height + this.composer.rows + this.shortcutHelp.height + STATUS_ROWS + this.tasks.height
    }
    return (
      this.agentSummary.height +
      this.live.height +
      this.queued.height +
      this.taskList.height +
      this.composer.rows +
      this.shortcutHelp.height +
      STATUS_ROWS +
      this.tasks.height
    )
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
    if (this.agentViewer.visible) return
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
      restore: (input) => this.composer.restore([input]),
      askSecret: (question) => this.askSecret(question),
    }
  }

  private runCommand(line: string): void {
    this.palette.hide()
    this.composer.setValue("")
    this.executeCommand(line)
    this.syncFooter()
  }

  private executeCommand(line: string): void {
    runCommand(line, this.commandContext()).catch((error: unknown) => {
      this.statusBar.setLoading(undefined)
      this.scrollback.append({ kind: "error", text: describeError(error) })
    })
  }

  private viewAgent(task: BackgroundAgentTask | undefined): void {
    const wasVisible = this.agentViewer.visible
    if (task) this.agentViewer.show(task)
    else this.agentViewer.hide()
    const mainVisible = task === undefined
    this.mainPanel.visible = mainVisible
    if (!mainVisible) this.palette.hide()
    this.syncFooter()
    if (mainVisible && wasVisible) {
      this.agentReplayPending = false
      this.replayAgentActivity()
    }
  }
}
