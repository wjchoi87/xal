import type { CliRenderer } from "@opentui/core"
import type { AgentSession } from "../../../agent/agent-session"
import { describeError } from "../../../lib/error"
import { nextPermissionMode } from "../../../permissions/types"
import type { Screen } from "../screen"

const QUIT_WINDOW_MS = 2000
const STOP_AGENTS_WINDOW_MS = 2000

export interface KeymapDeps {
  session: AgentSession
  screen: Screen
  edit(): Promise<void>
  quit(): void
}

export function bindKeys(renderer: CliRenderer, deps: KeymapDeps): void {
  const { session, screen, edit, quit } = deps
  let lastInterrupt = 0
  let lastEscape = 0
  let stopAgentsChord = 0

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
    if (key.name !== "escape") lastEscape = 0
    if (key.ctrl && key.name === "x" && screen.tasks.hasRunningAgents) {
      key.preventDefault()
      stopAgentsChord = Date.now()
      screen.statusBar.setNotice("Ctrl+K to stop all agents")
      const timer = setTimeout(() => {
        if (Date.now() - stopAgentsChord >= STOP_AGENTS_WINDOW_MS) screen.statusBar.clearNotice()
      }, STOP_AGENTS_WINDOW_MS)
      timer.unref()
      return
    }
    if (key.ctrl && key.name === "k" && Date.now() - stopAgentsChord < STOP_AGENTS_WINDOW_MS) {
      key.preventDefault()
      stopAgentsChord = 0
      screen.statusBar.setNotice(screen.tasks.stopAllAgents() ? "Stopping all agents…" : "No agents are running")
      const timer = setTimeout(() => screen.statusBar.clearNotice(), STOP_AGENTS_WINDOW_MS)
      timer.unref()
      return
    }
    if (key.ctrl && key.name === "c") {
      key.preventDefault()
      if (screen.secret.visible) {
        screen.secret.hide()
        screen.syncFooter()
        return
      }
      if (!screen.overlayVisible && screen.composer.clear()) return
      handleInterrupt()
      return
    }
    if (key.ctrl && key.name === "o") {
      key.preventDefault()
      screen.scrollback.toggleExpanded()
      return
    }
    if (key.ctrl && key.name === "t") {
      key.preventDefault()
      const visible = screen.scrollback.toggleReasoning()
      screen.statusBar.setNotice(`Thinking output ${visible ? "shown" : "hidden"}`)
      const timer = setTimeout(() => screen.statusBar.clearNotice(), 2_000)
      timer.unref()
      return
    }
    if (key.ctrl && key.name === "g" && !key.repeated && !screen.overlayVisible) {
      key.preventDefault()
      void edit().catch((error: unknown) => {
        screen.scrollback.append({ kind: "error", text: describeError(error) })
      })
      return
    }
    if (key.ctrl && key.name === "v" && !key.repeated && !screen.overlayVisible) {
      key.preventDefault()
      screen.statusBar.setNotice("Pasting image…")
      void screen.composer.pasteImage().then((pasted) => {
        screen.statusBar.setNotice(pasted ? "Image attached" : "No image found in clipboard")
        const timer = setTimeout(() => screen.statusBar.clearNotice(), 2_000)
        timer.unref()
      })
      return
    }
    if (key.ctrl && key.name === "u" && !screen.overlayVisible) {
      key.preventDefault()
      screen.composer.setValue("")
      return
    }
    if (key.ctrl && key.name === "r" && !screen.overlayVisible) {
      key.preventDefault()
      lastEscape = 0
      screen.openHistory()
      return
    }
    if (screen.permission.handleKey(key.name)) {
      key.preventDefault()
      screen.syncFooter()
      return
    }
    if (screen.elicitation.handleKey(key.name)) {
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
    const unmodified = !key.ctrl && !key.meta && !key.shift
    if (!screen.overlayVisible && unmodified && screen.tasks.handleKey(key.name)) {
      key.preventDefault()
      screen.syncFooter()
      return
    }
    if (
      !screen.overlayVisible &&
      unmodified &&
      key.name === "down" &&
      !screen.tasks.focused &&
      screen.tasks.count > 0 &&
      screen.composer.empty
    ) {
      key.preventDefault()
      screen.composer.blur()
      screen.tasks.focus()
      screen.syncFooter()
      return
    }
    if (
      !screen.overlayVisible &&
      (key.shift || key.meta) &&
      (key.name === "return" || key.name === "enter" || key.name === "kpenter" || key.name === "linefeed")
    ) {
      key.preventDefault()
      screen.composer.newLine()
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
    if (
      !screen.overlayVisible &&
      unmodified &&
      (key.name === "up" || key.name === "down") &&
      screen.composer.navigateHistory(key.name === "up" ? "older" : "newer")
    ) {
      key.preventDefault()
      return
    }
    if (key.name === "escape" && !screen.overlayVisible && screen.tasks.closeViewer()) {
      key.preventDefault()
      lastEscape = 0
      screen.syncFooter()
      return
    }
    if (key.name === "escape" && !screen.overlayVisible && session.currentState === "idle") {
      key.preventDefault()
      if (key.repeated) {
        lastEscape = 0
        return
      }
      const now = Date.now()
      if (now - lastEscape < 500) {
        lastEscape = 0
        screen.openHistory()
        return
      }
      lastEscape = now
      return
    }
    if (key.name === "escape" && session.currentState !== "idle") {
      lastEscape = 0
      session.interrupt("promote")
    }
  })

  renderer.keyInput.on("paste", (event) => {
    if (!screen.secret.handlePaste(event)) return
    event.preventDefault()
    screen.syncFooter()
  })
}
