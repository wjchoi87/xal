import { BoxRenderable, createCliRenderer } from "@opentui/core"
import { runTurn, type UiSink } from "../agent/loop"
import { Session } from "../agent/session"
import { appInfo } from "../app-info"
import { getProvider } from "../providers/registry"
import { ChatLog, type StreamingText, type ToolCell } from "./chat-log"
import { Composer } from "./composer"
import { StatusBar } from "./status-bar"
import { TuiPermissionService } from "./approval"

type UiState = "idle" | "working" | "approval"

const IDLE_HINT = "idle — Enter to send · Ctrl+C twice to quit"
const WORKING_HINT = "working — Esc to interrupt"
const APPROVAL_HINT = "awaiting approval — [y] run · [n] deny · [Esc] interrupt"

export async function startTui(): Promise<void> {
  const provider = getProvider("chatgpt")!
  if (!(await provider.isLoggedIn())) {
    console.log(`not logged in — run: ${appInfo.name} login chatgpt`)
    process.exit(1)
  }
  const model = await provider.defaultModel()

  const renderer = await createCliRenderer({ exitOnCtrlC: false })
  const root = new BoxRenderable(renderer, { flexDirection: "column", width: "100%", height: "100%" })
  renderer.root.add(root)

  const chatLog = new ChatLog(renderer)
  const statusBar = new StatusBar(renderer, model)

  const session = new Session()
  let state: UiState = "idle"
  let abort: AbortController | undefined
  let lastCtrlC = 0
  let assistant: StreamingText | undefined
  let thinking: StreamingText | undefined
  let toolCell: ToolCell | undefined

  function quit(): void {
    try {
      renderer.destroy()
    } catch {}
    process.exit(0)
  }

  function setIdle(): void {
    state = "idle"
    abort = undefined
    assistant = undefined
    thinking = undefined
    toolCell = undefined
    statusBar.setState(IDLE_HINT)
    composer.focus()
  }

  const permissions = new TuiPermissionService({
    onRequest(request) {
      state = "approval"
      composer.blur()
      toolCell = chatLog.addToolCell(request.title)
      statusBar.setState(APPROVAL_HINT)
    },
    onResolve() {
      state = "working"
      statusBar.setState(WORKING_HINT)
    },
  })

  const sink: UiSink = {
    onTextDelta(text) {
      thinking = undefined
      assistant ??= chatLog.startAssistant()
      assistant.append(text)
    },
    onThinkingDelta(text) {
      thinking ??= chatLog.startThinking()
      thinking.append(text)
    },
    onToolStart() {
      toolCell?.markRunning()
      assistant = undefined
      thinking = undefined
    },
    onToolResult(_callId, output, denied) {
      if (denied) toolCell?.markDenied(output)
      else toolCell?.setOutput(output)
      toolCell = undefined
      assistant = undefined
      thinking = undefined
    },
    onInterrupted() {
      chatLog.addInfo("(interrupted)")
    },
    onTurnEnd() {},
  }

  function submit(text: string): void {
    if (state !== "idle") return
    chatLog.addUser(text)
    session.addUserMessage(text)
    state = "working"
    statusBar.setState(WORKING_HINT)
    abort = new AbortController()
    runTurn(session, { provider, model, permissions, sink }, abort.signal)
      .catch((error) => {
        chatLog.addError(error instanceof Error ? error.message : String(error))
      })
      .finally(() => {
        setIdle()
      })
  }

  const composer = new Composer(renderer, submit)

  root.add(chatLog.view)
  root.add(composer.view)
  root.add(statusBar.view)

  function interrupt(): void {
    abort?.abort()
    if (permissions.hasPending) permissions.resolvePending("deny")
  }

  function handleCtrlC(): void {
    if (state !== "idle") {
      interrupt()
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
      if (state === "idle") statusBar.setState(IDLE_HINT)
    }, 2000)
  }

  renderer.keyInput.on("keypress", (key) => {
    if (key.ctrl && key.name === "c") {
      key.preventDefault()
      handleCtrlC()
      return
    }
    if (key.name === "escape") {
      if (state !== "idle") interrupt()
      return
    }
    if (state !== "approval") return
    if (key.name === "y") {
      key.preventDefault()
      permissions.resolvePending("allow")
      return
    }
    if (key.name === "n") {
      key.preventDefault()
      permissions.resolvePending("deny")
    }
  })

  chatLog.addInfo(`${appInfo.name} v${appInfo.version} · ${model} · ${process.cwd()}`)
  chatLog.addInfo("type a message and press Enter — every bash command asks for approval first")
  composer.focus()
}
