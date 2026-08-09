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
import { appInfo } from "../../app-info"
import { registerCommand } from "../../commands/registry"
import type { EventService } from "../../events"
import { describeError } from "../../lib/error"
import { compactPath } from "../../lib/path"
import { findProjectRoot } from "../../project/root"
import type { UiOptions } from "../../ui/registry"
import { AgentEventController } from "./controllers/agent-events"
import { AppEventController, InputQueue } from "./controllers/app-events"
import { bindKeys } from "./controllers/keymap"
import { COMPOSER_ROWS } from "./components/composer"
import { STATUS_ROWS } from "./components/status-bar"
import { cursorRow } from "./lib/cursor"
import { MessageHistory } from "./message-history"
import { Screen } from "./screen"
import { describeTerminal } from "./terminal"
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

export async function startTui(events: EventService, options: UiOptions = {}): Promise<void> {
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
  if (renderer.capabilities) applyKeyboardProtocol(renderer, renderer.capabilities)
  renderer.on(CliRenderEvents.CAPABILITIES, (capabilities: TerminalCapabilities) => {
    applyKeyboardProtocol(renderer, capabilities)
  })
  process.on("exit", restoreTerminal)
  renderer.setTerminalTitle(`${appInfo.name} — ${compactPath(process.cwd())}`)

  const input = new InputQueue((submission) => session.send(submission))
  const screen = new Screen(renderer, session, startRow, history, {
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
    screen.scrollback.append({ kind: "banner", model, cwd: compactPath(process.cwd()) })
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
  renderer.on(CliRenderEvents.RESIZE, () => {
    if (renderer.terminalWidth === lastWidth && renderer.terminalHeight === lastHeight) return
    lastWidth = renderer.terminalWidth
    lastHeight = renderer.terminalHeight
    clearTimeout(replayTimer)
    replayTimer = setTimeout(() => {
      screen.composer.reflow()
      screen.scrollback.replay()
    }, RESIZE_DEBOUNCE_MS)
  })

  const quit = (): void => {
    renderer.externalOutputMode = "passthrough"
    renderer.screenMode = "main-screen"
    renderer.destroy()
  }

  registerCommand({
    name: "terminal",
    describe: "show detected terminal capabilities",
    async run(_args, ctx) {
      for (const line of describeTerminal(renderer.capabilities)) ctx.print(line)
    },
  })

  registerCommand({
    name: "quit",
    describe: `exit ${appInfo.name}`,
    async run() {
      quit()
    },
  })

  bindKeys(renderer, { session, screen, quit })

  screen.composer.focus()
  await destroyed
  clearTimeout(replayTimer)
}
