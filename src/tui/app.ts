import { BoxRenderable, createCliRenderer } from "@opentui/core"
import { AgentSession } from "../agent/agent-session"
import type { AgentEvent, AgentState } from "../agent/events"
import { appInfo } from "../app-info"
import { askPolicy } from "../permissions/service"
import { getProvider } from "../providers/registry"
import { ChatLog, type StreamingText, type ToolCell } from "./chat-log"
import { Composer } from "./composer"
import { StatusBar } from "./status-bar"

const HINTS: Record<AgentState, string> = {
  idle: "idle — Enter to send · Ctrl+C twice to quit",
  streaming: "working — Esc to interrupt",
  awaiting_approval: "awaiting approval — [y] run · [n] deny · [Esc] interrupt",
  running_tool: "running command — Esc to interrupt",
}

export async function startTui(): Promise<void> {
  const provider = getProvider("chatgpt")!
  if (!(await provider.isLoggedIn())) {
    console.log(`not logged in — run: ${appInfo.name} login chatgpt`)
    process.exit(1)
  }
  const model = await provider.defaultModel()
  const session = new AgentSession({ provider, model, policy: askPolicy })

  const renderer = await createCliRenderer({ exitOnCtrlC: false })
  const root = new BoxRenderable(renderer, { flexDirection: "column", width: "100%", height: "100%" })
  renderer.root.add(root)

  const chatLog = new ChatLog(renderer)
  const statusBar = new StatusBar(renderer, model)
  const composer = new Composer(renderer, (text) => session.send(text))

  root.add(chatLog.view)
  root.add(composer.view)
  root.add(statusBar.view)

  let assistant: StreamingText | undefined
  let thinking: StreamingText | undefined
  let toolCell: ToolCell | undefined
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
        statusBar.setState(HINTS[event.state])
        if (event.state === "awaiting_approval") composer.blur()
        else composer.focus()
        if (event.state === "idle") {
          assistant = undefined
          thinking = undefined
          toolCell = undefined
        }
        break
      case "user_message":
        chatLog.addUser(event.text)
        break
      case "text_delta":
        thinking = undefined
        assistant ??= chatLog.startAssistant()
        assistant.append(event.text)
        break
      case "thinking_delta":
        thinking ??= chatLog.startThinking()
        thinking.append(event.text)
        break
      case "approval_requested":
        toolCell = chatLog.addToolCell(event.title)
        break
      case "tool_started":
        toolCell ??= chatLog.addToolCell(event.title)
        toolCell.markRunning()
        assistant = undefined
        thinking = undefined
        break
      case "tool_finished": {
        const cell = toolCell ?? chatLog.addToolCell(event.title)
        if (event.denied) cell.markDenied(event.output)
        else cell.setOutput(event.output)
        toolCell = undefined
        assistant = undefined
        thinking = undefined
        break
      }
      case "turn_interrupted":
        chatLog.addInfo("(interrupted)")
        break
      case "turn_ended":
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
    statusBar.setState("press Ctrl+C again to quit")
    setTimeout(() => {
      if (session.currentState === "idle") statusBar.setState(HINTS.idle)
    }, 2000)
  }

  renderer.keyInput.on("keypress", (key) => {
    if (key.ctrl && key.name === "c") {
      key.preventDefault()
      handleCtrlC()
      return
    }
    if (key.name === "escape") {
      if (session.currentState !== "idle") session.interrupt()
      return
    }
    if (session.currentState !== "awaiting_approval") return
    if (key.name === "y") {
      key.preventDefault()
      session.approve()
      return
    }
    if (key.name === "n") {
      key.preventDefault()
      session.deny()
    }
  })

  chatLog.addInfo(`${appInfo.name} v${appInfo.version} · ${model} · ${process.cwd()}`)
  chatLog.addInfo("type a message and press Enter — every bash command asks for approval first")
  composer.focus()
}
