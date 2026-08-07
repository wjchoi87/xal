import { CliRenderEvents, createCliRenderer, RenderableEvents } from "@opentui/core"
import { createSession, resumeSession } from "../../agent/compose"
import { appInfo } from "../../app-info"
import { registerCommand } from "../../commands/registry"
import type { EventService } from "../../events"
import { describeError } from "../../lib/error"
import { compactPath } from "../../lib/path"
import type { UiOptions } from "../../ui/registry"
import { AgentEventController } from "./controllers/agent-events"
import { AppEventController, InputQueue } from "./controllers/app-events"
import { bindKeys } from "./controllers/keymap"
import { COMPOSER_ROWS } from "./components/composer"
import { STATUS_ROWS } from "./components/status-bar"
import { cursorRow } from "./lib/cursor"
import { Screen } from "./screen"
import { COLORS } from "./theme/colors"

const RESIZE_DEBOUNCE_MS = 60

export async function startTui(events: EventService, options: UiOptions = {}): Promise<void> {
  const { session, provider, model } = await createSession({ persist: true })
  if (!(await provider.isLoggedIn())) {
    console.log(`not connected — run: ${appInfo.name} connect ${provider.aliases[0] ?? provider.id}`)
    process.exit(1)
  }

  const startRow = await cursorRow()

  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    useMouse: false,
    clearOnShutdown: false,
    screenMode: "split-footer",
    footerHeight: COMPOSER_ROWS + STATUS_ROWS,
    backgroundColor: COLORS.background,
  })
  process.on("exit", () => process.stdout.write("\u001b[r\u001b[<u\u001b[?25h"))
  renderer.setTerminalTitle(`${appInfo.name} — ${compactPath(process.cwd())}`)

  const input = new InputQueue((text) => session.send(text))
  const screen = new Screen(renderer, session, startRow, {
    submit: (text) => input.submit(text),
    approve: (scope, pattern) => session.approve(scope, pattern),
    deny: () => session.deny(),
    cancel: () => session.interrupt(),
  })
  renderer.root.add(screen.view)

  const agentEvents = new AgentEventController(screen)
  session.subscribe((event) => agentEvents.handle(event))

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

  const appEvents = new AppEventController(screen, input)
  const unsubscribe = events.subscribe((event) => appEvents.handle(event), true)
  screen.view.on(RenderableEvents.DESTROYED, unsubscribe)

  let lastWidth = renderer.terminalWidth
  let replayTimer: ReturnType<typeof setTimeout> | undefined
  renderer.on(CliRenderEvents.RESIZE, () => {
    if (renderer.terminalWidth === lastWidth) return
    lastWidth = renderer.terminalWidth
    clearTimeout(replayTimer)
    replayTimer = setTimeout(() => screen.scrollback.replay(), RESIZE_DEBOUNCE_MS)
  })

  const quit = (): void => {
    try {
      renderer.externalOutputMode = "passthrough"
      renderer.screenMode = "main-screen"
      renderer.destroy()
    } catch {}
    process.exit(0)
  }

  registerCommand({
    name: "quit",
    describe: `exit ${appInfo.name}`,
    async run() {
      quit()
    },
  })

  bindKeys(renderer, { session, screen, quit })

  screen.composer.focus()
}
