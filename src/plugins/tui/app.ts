import { createCliRenderer, RenderableEvents } from "@opentui/core"
import { createSession } from "../../agent/compose"
import { appInfo } from "../../app-info"
import type { EventService } from "../../events"
import { AgentEventController } from "./controllers/agent-events"
import { AppEventController, InputQueue } from "./controllers/app-events"
import { bindKeys } from "./controllers/keymap"
import { compactPath } from "./lib/format"
import { Screen } from "./screen"
import { COLORS } from "./theme/colors"

export async function startTui(events: EventService): Promise<void> {
  const { session, provider, model } = await createSession()
  if (!(await provider.isLoggedIn())) {
    console.log(`not logged in — run: ${appInfo.name} login ${provider.aliases[0] ?? provider.id}`)
    process.exit(1)
  }

  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    useMouse: true,
    backgroundColor: COLORS.background,
  })
  renderer.setTerminalTitle(`${appInfo.name} — ${compactPath(process.cwd())}`)

  const input = new InputQueue((text) => session.send(text))
  const screen = new Screen(renderer, model, {
    submit: (text) => input.submit(text),
    approve: () => session.approve(),
    deny: () => session.deny(),
    cancel: () => session.interrupt(),
  })
  renderer.root.add(screen.root)

  const agentEvents = new AgentEventController(screen)
  session.subscribe((event) => agentEvents.handle(event))

  const appEvents = new AppEventController(screen, input)
  const unsubscribe = events.subscribe((event) => appEvents.handle(event), true)
  screen.root.on(RenderableEvents.DESTROYED, unsubscribe)

  bindKeys(renderer, {
    session,
    screen,
    quit: () => {
      try {
        renderer.destroy()
      } catch {}
      process.exit(0)
    },
  })

  screen.composer.focus()
}
