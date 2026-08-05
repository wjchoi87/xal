import { BoxRenderable, createCliRenderer } from "@opentui/core"
import { AgentSession } from "../agent/agent-session"
import type { AgentEvent } from "../agent/events"
import { appInfo } from "../app-info"
import { askPolicy } from "../permissions/service"
import { getProvider } from "../providers/registry"
import { ChatLog, type StreamingText } from "./chat-log"
import { Composer } from "./composer"
import { PermissionPopover } from "./permission-popover"
import { StatusBar } from "./status-bar"
import { compactPath } from "./text"
import { COLORS } from "./theme"
import type { ToolCell } from "./tool-cell"

export async function startTui(): Promise<void> {
  const provider = getProvider("chatgpt")!
  if (!(await provider.isLoggedIn())) {
    console.log(`not logged in — run: ${appInfo.name} login chatgpt`)
    process.exit(1)
  }

  const cwd = process.cwd()
  const model = await provider.defaultModel()
  const session = new AgentSession({ provider, model, policy: askPolicy })
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    useMouse: true,
    backgroundColor: COLORS.background,
  })
  renderer.setTerminalTitle(`${appInfo.name} — ${compactPath(cwd)}`)

  const root = new BoxRenderable(renderer, {
    flexDirection: "column",
    width: "100%",
    height: "100%",
  })
  renderer.root.add(root)

  const chatLog = new ChatLog(renderer)
  const composer = new Composer(renderer, (text) => session.send(text))
  const statusBar = new StatusBar(renderer, model)
  const permission = new PermissionPopover(renderer, {
    approve: () => session.approve(),
    deny: () => session.deny(),
    cancel: () => session.interrupt(),
  })

  root.add(chatLog.view)
  root.add(permission.view)
  root.add(composer.view)
  root.add(statusBar.view)

  let assistant: StreamingText | undefined
  let reasoningSummary: StreamingText | undefined
  const toolCells = new Map<string, ToolCell>()
  let lastCtrlC = 0

  function quit(): void {
    try {
      renderer.destroy()
    } catch {}
    process.exit(0)
  }

  function handleEvent(event: AgentEvent): void {
    switch (event.type) {
      case "state_changed":
        statusBar.setState(event.state)
        if (event.state === "awaiting_approval") composer.blur()
        else composer.focus()
        if (event.state === "idle") {
          permission.hide()
          composer.setPopoverVisible(false)
          assistant = undefined
          reasoningSummary = undefined
          toolCells.clear()
        }
        break
      case "user_message":
        chatLog.addUser(event.text, event.sentAt)
        break
      case "text_delta":
        reasoningSummary = undefined
        assistant ??= chatLog.startAssistant()
        assistant.append(event.text)
        break
      case "reasoning_summary_delta":
        reasoningSummary ??= chatLog.startReasoningSummary()
        reasoningSummary.append(event.text)
        break
      case "reasoning_delta":
        break
      case "approval_requested": {
        const cell = chatLog.addToolCell(event.tool, event.title)
        toolCells.set(event.callId, cell)
        permission.show(event.title)
        composer.setPopoverVisible(true)
        break
      }
      case "tool_started": {
        permission.hide()
        composer.setPopoverVisible(false)
        const cell = toolCells.get(event.callId) ?? chatLog.addToolCell("bash", event.title)
        toolCells.set(event.callId, cell)
        cell.markRunning()
        assistant = undefined
        reasoningSummary = undefined
        break
      }
      case "tool_finished": {
        permission.hide()
        composer.setPopoverVisible(false)
        const cell = toolCells.get(event.callId) ?? chatLog.addToolCell("tool", event.title)
        if (event.denied) cell.markDenied(event.output)
        else cell.setOutput(event.output)
        toolCells.delete(event.callId)
        assistant = undefined
        reasoningSummary = undefined
        break
      }
      case "turn_interrupted":
        chatLog.addInfo("Interrupted")
        break
      case "turn_ended":
        composer.setUsage(event.usage)
        break
      case "error":
        chatLog.addError(event.message)
        break
    }
  }

  session.subscribe(handleEvent)

  function handleCtrlC(): void {
    if (session.currentState !== "idle") {
      session.interrupt()
      return
    }
    const now = Date.now()
    if (now - lastCtrlC < 2000) {
      quit()
      return
    }
    lastCtrlC = now
    statusBar.setNotice("Ctrl+C again to quit")
    setTimeout(() => {
      if (session.currentState === "idle") statusBar.setState("idle")
    }, 2000)
  }

  renderer.keyInput.on("keypress", (key) => {
    if (key.ctrl && key.name === "c") {
      key.preventDefault()
      handleCtrlC()
      return
    }
    if (key.ctrl && key.name === "o") {
      key.preventDefault()
      chatLog.toggleToolOutput()
      return
    }
    if (permission.handleKey(key.name)) {
      key.preventDefault()
      composer.setPopoverVisible(permission.visible)
      return
    }
    if (key.name === "pageup" || key.name === "pagedown") {
      key.preventDefault()
      chatLog.scrollPage(key.name === "pageup" ? -1 : 1)
      return
    }
    if (key.name === "escape") {
      if (session.currentState !== "idle") session.interrupt()
    }
  })

  composer.focus()
}
