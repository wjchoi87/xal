import {
  buildKittyKeyboardFlags,
  CliRenderEvents,
  createCliRenderer,
  RenderableEvents,
  type CliRenderer,
  type KittyKeyboardOptions,
  type TerminalCapabilities,
} from "@opentui/core"
import { createSession, resumeSession } from "../../agent/compose"
import type { EventService } from "../../events"
import { describeError } from "../../lib/error"
import { compactPath } from "../../lib/path"
import { findProjectRoot } from "../../project/root"
import type { UiOptions } from "../../ui/registry"
import { AgentEventController } from "./controllers/agent-events"
import { AppEventController, InputQueue } from "./controllers/app-events"
import { bindKeys } from "./controllers/keymap"
import { setTuiCommandActions } from "./commands"
import { COMPOSER_ROWS } from "./components/composer"
import { STATUS_ROWS } from "./components/status-bar"
import type { TuiConfig } from "./config"
import { editInExternalEditor, externalEditorCommand } from "./external-editor"
import { cursorRow } from "./lib/cursor"
import { MessageHistory } from "./message-history"
import { Screen } from "./screen"
import { describeTerminal, sessionTerminalTitle } from "./terminal"
import { COLORS } from "./theme/colors"

const RESIZE_DEBOUNCE_MS = 60
const TERMINAL_RESET = "\u001b[r\u001b[<u\u001b[?25h"
const KITTY_KEYBOARD: KittyKeyboardOptions = { allKeysAsEscapes: true, reportText: true }

function applyKeyboardProtocol(renderer: CliRenderer, capabilities: TerminalCapabilities): void {
  if (capabilities.kitty_keyboard) {
    renderer.enableKittyKeyboard(buildKittyKeyboardFlags(KITTY_KEYBOARD))
    return
  }
  renderer.disableKittyKeyboard()
}

function comparableEditorText(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/\n$/, "")
}

export async function startTui(events: EventService, config: TuiConfig, options: UiOptions = {}): Promise<void> {
  const root = await findProjectRoot(process.cwd())
  const [{ session, model }, history] = await Promise.all([
    createSession({ persist: true, interactive: true }),
    MessageHistory.load(root),
  ])

  const startRow = await cursorRow()
  const { promise: destroyed, resolve: finishDestroy } = Promise.withResolvers<void>()
  const restoreTerminal = (): void => {
    process.stdout.write(TERMINAL_RESET)
  }

  const existingResizeListeners = new Set(process.listeners("SIGWINCH"))
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    useMouse: false,
    clearOnShutdown: false,
    screenMode: "split-footer",
    footerHeight: COMPOSER_ROWS + STATUS_ROWS,
    useKittyKeyboard: KITTY_KEYBOARD,
    backgroundColor: COLORS.background,
    onDestroy() {
      process.off("exit", restoreTerminal)
      process.stdout.write(TERMINAL_RESET, () => finishDestroy())
    },
  })
  const rendererResizeListener = process
    .listeners("SIGWINCH")
    .find((listener) => !existingResizeListeners.has(listener))
  if (renderer.capabilities) applyKeyboardProtocol(renderer, renderer.capabilities)
  renderer.on(CliRenderEvents.CAPABILITIES, (capabilities: TerminalCapabilities) => {
    applyKeyboardProtocol(renderer, capabilities)
  })
  process.on("exit", restoreTerminal)
  renderer.setTerminalTitle(sessionTerminalTitle())

  const quit = (): void => {
    renderer.externalOutputMode = "passthrough"
    renderer.screenMode = "main-screen"
    renderer.destroy()
  }
  const input = new InputQueue((submission) => session.send(submission))
  const screen = new Screen(renderer, session, startRow, history, config, {
    submit: (submission) => input.submit(submission),
    approve: (scope, pattern) => session.approve(scope, pattern),
    deny: () => session.deny(),
    cancel: () => session.interrupt("promote"),
    answer: (requestId, answers) => {
      session.answerElicitation(requestId, answers)
    },
    reject: (requestId) => {
      session.rejectElicitation(requestId)
    },
  })
  renderer.root.add(screen.view)
  const resetCommands = setTuiCommandActions({
    config: () => screen.openConfig(),
    terminal: () => describeTerminal(renderer.capabilities),
    quit,
  })

  const agentEvents = new AgentEventController(screen, session)
  session.subscribe((event) => agentEvents.handle(event))
  agentEvents.trackContextWindow()

  if (options.resume) {
    try {
      for (const notice of await resumeSession(session, options.resume)) {
        screen.scrollback.append({ kind: "info", text: notice })
      }
    } catch (error) {
      screen.scrollback.append({ kind: "error", text: describeError(error) })
    }
  } else {
    screen.scrollback.append({ kind: "banner", model, cwd: compactPath(session.currentWorkingDirectory) })
  }
  if (!(await session.currentProvider.isLoggedIn().catch(() => false))) {
    screen.scrollback.append({ kind: "info", text: "not connected — run /connect" })
  }

  const appEvents = new AppEventController(screen, input)
  const unsubscribe = events.subscribe((event) => appEvents.handle(event), true)
  screen.view.on(RenderableEvents.DESTROYED, unsubscribe)

  let lastWidth = renderer.terminalWidth
  let lastHeight = renderer.terminalHeight
  let replayTimer: ReturnType<typeof setTimeout> | undefined
  let replayPending = false
  let editing = false
  const replayLayout = (): void => {
    screen.composer.reflow()
    screen.syncFooter()
    screen.scrollback.replay()
  }
  renderer.on(CliRenderEvents.RESIZE, () => {
    if (renderer.terminalWidth === lastWidth && renderer.terminalHeight === lastHeight) return
    lastWidth = renderer.terminalWidth
    lastHeight = renderer.terminalHeight
    if (editing) {
      replayPending = true
      return
    }
    clearTimeout(replayTimer)
    replayTimer = setTimeout(() => {
      replayTimer = undefined
      replayLayout()
    }, RESIZE_DEBOUNCE_MS)
  })

  const edit = async (): Promise<void> => {
    if (editing) return
    if (session.currentState !== "idle") throw new Error("external editor is available when the agent is idle")
    editing = true
    if (replayTimer !== undefined) {
      clearTimeout(replayTimer)
      replayTimer = undefined
      replayPending = true
    }
    try {
      const command = externalEditorCommand()
      const draft = screen.composer.draft()
      const ignoreInterrupt = (): void => {}
      let suspended = false
      let text: string
      process.on("SIGINT", ignoreInterrupt)
      if (rendererResizeListener) process.off("SIGWINCH", rendererResizeListener)
      try {
        renderer.suspend()
        suspended = true
        text = await editInExternalEditor(command, draft.text)
      } finally {
        try {
          if (suspended) {
            renderer.resize(
              process.stdout.columns || renderer.terminalWidth,
              process.stdout.rows || renderer.terminalHeight,
            )
            renderer.resume()
          }
        } finally {
          if (rendererResizeListener) process.on("SIGWINCH", rendererResizeListener)
          process.off("SIGINT", ignoreInterrupt)
        }
      }
      if (comparableEditorText(text) !== comparableEditorText(draft.text)) {
        screen.composer.replaceDraft({ ...draft, text }, draft)
      }
      screen.syncFooter()
    } finally {
      editing = false
      if (replayPending) {
        replayPending = false
        replayLayout()
      }
    }
  }

  bindKeys(renderer, { session, screen, edit, quit })

  screen.composer.focus()
  await destroyed
  resetCommands()
  clearTimeout(replayTimer)
}
