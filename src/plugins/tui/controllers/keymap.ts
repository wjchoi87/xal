import type { CliRenderer } from "@opentui/core"
import type { AgentSession } from "../../../agent/agent-session"
import { nextPermissionMode } from "../../../permissions/types"
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
    const timer = setTimeout(() => {
      if (session.currentState === "idle") screen.statusBar.clearNotice()
    }, QUIT_WINDOW_MS)
    timer.unref()
  }

  renderer.keyInput.on("keypress", (key) => {
    if (key.ctrl && key.name === "c") {
      key.preventDefault()
      if (screen.secret.visible) {
        screen.secret.hide()
        screen.syncFooter()
        return
      }
      handleInterrupt()
      return
    }
    if (key.ctrl && key.name === "o") {
      key.preventDefault()
      screen.scrollback.toggleExpanded()
      return
    }
    if (key.ctrl && key.name === "u" && !screen.overlayVisible) {
      key.preventDefault()
      screen.composer.setValue("")
      return
    }
    if (screen.permission.handleKey(key.name)) {
      key.preventDefault()
      screen.syncFooter()
      return
    }
    if (screen.secret.handleKey(key)) {
      key.preventDefault()
      screen.syncFooter()
      return
    }
    if (screen.picker.handleKey(key.name)) {
      key.preventDefault()
      screen.syncFooter()
      return
    }
    if (key.shift && key.name === "tab") {
      key.preventDefault()
      session.setMode(nextPermissionMode(session.currentMode))
      return
    }
    if (screen.palette.handleKey(key.name)) {
      key.preventDefault()
      return
    }
    if (key.name === "escape" && session.currentState !== "idle") session.interrupt()
  })

  renderer.keyInput.on("paste", (event) => {
    if (!screen.secret.handlePaste(event)) return
    event.preventDefault()
    screen.syncFooter()
  })
}
