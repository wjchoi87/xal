import { CliRenderEvents, createCliRenderer, RenderableEvents } from "@opentui/core"
import { createSession } from "../../agent/compose"
import { appInfo } from "../../app-info"
import type { EventService } from "../../events"
import { AgentEventController } from "./controllers/agent-events"
import { AppEventController, InputQueue } from "./controllers/app-events"
import { bindKeys } from "./controllers/keymap"
import { COMPOSER_ROWS } from "./components/composer"
import { STATUS_ROWS } from "./components/status-bar"
import { compactPath } from "./lib/format"
import { Screen } from "./screen"
import { COLORS } from "./theme/colors"

const RESIZE_DEBOUNCE_MS = 60
const RESET_SCROLL_REGION = "\u001b[r"

export async function startTui(events: EventService): Promise<void> {
  const { session, provider, model } = await createSession()
  if (!(await provider.isLoggedIn())) {
    console.log(`not connected — run: ${appInfo.name} connect ${provider.aliases[0] ?? provider.id}`)
    process.exit(1)
  }

  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    useMouse: false,
    clearOnShutdown: false,
    screenMode: "split-footer",
    footerHeight: COMPOSER_ROWS + STATUS_ROWS,
    backgroundColor: COLORS.background,
  })
  process.on("exit", () => process.stdout.write(RESET_SCROLL_REGION))
  renderer.setTerminalTitle(`${appInfo.name} — ${compactPath(process.cwd())}`)

  const input = new InputQueue((text) => session.send(text))
  const screen = new Screen(renderer, model, {
    submit: (text) => input.submit(text),
    approve: () => session.approve(),
    deny: () => session.deny(),
    cancel: () => session.interrupt(),
  })
  renderer.root.add(screen.view)
  screen.scrollback.append({ kind: "banner", model, cwd: compactPath(process.cwd()) })

  const agentEvents = new AgentEventController(screen)
  session.subscribe((event) => agentEvents.handle(event))

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

  bindKeys(renderer, {
    session,
    screen,
    quit: () => {
      try {
        renderer.externalOutputMode = "passthrough"
        renderer.screenMode = "main-screen"
        renderer.destroy()
      } catch {}
      process.exit(0)
    },
  })

  screen.composer.focus()
}
