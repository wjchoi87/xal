import type { CliRenderer } from "@opentui/core"
import type { AgentSession } from "../../../agent/agent-session"
import type { Screen } from "../screen"

const QUIT_WINDOW_MS = 2000

export interface KeymapDeps {
  session: AgentSession
  screen: Screen
  quit(): void
}

export function bindKeys(renderer: CliRenderer, deps: KeymapDeps): void {
  const { session, screen, quit } = deps
  let lastInterrupt = 0

  function handleInterrupt(): void {
    if (session.currentState !== "idle") {
      session.interrupt()
      return
    }
    const now = Date.now()
    if (now - lastInterrupt < QUIT_WINDOW_MS) {
      quit()
      return
    }
    lastInterrupt = now
    screen.statusBar.setNotice("Ctrl+C again to quit")
    setTimeout(() => {
      if (session.currentState === "idle") screen.statusBar.clearNotice()
    }, QUIT_WINDOW_MS)
  }

  renderer.keyInput.on("keypress", (key) => {
    if (key.ctrl && key.name === "c") {
      key.preventDefault()
      handleInterrupt()
      return
    }
    if (key.ctrl && key.name === "o") {
      key.preventDefault()
      screen.scrollback.toggleExpanded()
      return
    }
    if (screen.permission.handleKey(key.name)) {
      key.preventDefault()
      screen.syncFooter()
      return
    }
    if (key.name === "escape" && session.currentState !== "idle") session.interrupt()
  })
}
