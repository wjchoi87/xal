import { release } from "node:os"
import { appInfo } from "../app-info"
import { describeError } from "../lib/error"
import { rememberRule } from "../permissions/rules"
import { evaluatePolicy } from "../permissions/service"
import type { PermissionMode, PermissionScope } from "../permissions/types"
import type { ConversationItem, Provider, Usage } from "../providers/types"
import { SessionRecorder } from "../sessions/recorder"
import type { LoadedSession, SessionMeta } from "../sessions/types"
import { getTool, listTools } from "../tools/registry"
import type { AgentEvent, AgentState, DenialCause } from "./events"
import { composeSystemPrompt } from "./prompt"

export interface AgentSessionDeps {
  provider: Provider
  model: string
  persist?: boolean
}

export interface ResumeTarget {
  session: LoadedSession
  path: string
  provider: Provider
  model: string
  mode: PermissionMode
}

type StreamKind = "assistant" | "reasoning"

interface PendingToolCall {
  callId: string
  name: string
  args: Record<string, unknown>
}

interface ApprovalResult {
  decision: "allow" | "deny"
  scope?: PermissionScope
  pattern?: string
  cause?: DenialCause
  message?: string
}

const denialMessages: Record<DenialCause, string> = {
  user: "User denied permission to run this action.",
  policy: "Blocked by the active permission rules.",
  plan: "Plan mode is active, so this action was not run. Finish investigating and present a plan instead of retrying.",
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError"
}

export class AgentSession {
  private sessionId: string = crypto.randomUUID()
  private startedAt = Date.now()
  private items: ConversationItem[] = []
  private readonly listeners = new Set<(event: AgentEvent) => void>()
  private readonly recorder: SessionRecorder | undefined
  private provider: Provider
  private model: string
  private state: AgentState = "idle"
  private mode: PermissionMode = "build"
  private streaming: { kind: StreamKind; text: string } | undefined
  private abortController: AbortController | undefined
  private pendingApproval: ((result: ApprovalResult) => void) | undefined

  constructor(deps: AgentSessionDeps) {
    this.provider = deps.provider
    this.model = deps.model
    if (deps.persist) {
      this.recorder = new SessionRecorder((message) => this.emit({ type: "error", message }))
      this.recorder.start(this.meta())
    }
  }

  get id(): string {
    return this.sessionId
  }

  get currentState(): AgentState {
    return this.state
  }

  get currentMode(): PermissionMode {
    return this.mode
  }

  get currentModel(): string {
    return this.model
  }

  get currentProvider(): Provider {
    return this.provider
  }

  private meta(): SessionMeta {
    return {
      id: this.sessionId,
      cwd: process.cwd(),
      provider: this.provider.id,
      model: this.model,
      mode: this.mode,
      startedAt: this.startedAt,
    }
  }

  reset(): boolean {
    if (this.state !== "idle") return false
    this.sessionId = crypto.randomUUID()
    this.startedAt = Date.now()
    this.items = []
    this.streaming = undefined
    this.recorder?.start(this.meta())
    this.emit({ type: "session_started", id: this.sessionId, resumed: false, model: this.model, mode: this.mode })
    return true
  }

  resume(target: ResumeTarget): boolean {
    if (this.state !== "idle") return false
    const { meta } = target.session
    this.sessionId = meta.id
    this.startedAt = meta.startedAt
    this.items = [...target.session.items]
    this.streaming = undefined
    this.provider = target.provider
    this.model = target.model
    this.mode = target.mode
    this.recorder?.attach(target.path)
    this.emit({ type: "session_started", id: this.sessionId, resumed: true, model: this.model, mode: this.mode })
    for (const event of target.session.events) this.notify(event)
    return true
  }

  setModel(provider: Provider, model: string): void {
    if (this.provider === provider && this.model === model) return
    this.provider = provider
    this.model = model
    this.emit({ type: "model_changed", provider: provider.id, model })
  }

  setMode(mode: PermissionMode): void {
    if (this.mode === mode) return
    this.mode = mode
    this.emit({ type: "mode_changed", mode })
  }

  subscribe(listener: (event: AgentEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  send(text: string): boolean {
    if (this.state !== "idle") return false
    this.pushItem({ role: "user", content: [{ type: "input_text", text }] })
    this.emit({ type: "user_message", text, sentAt: Date.now() })
    const controller = new AbortController()
    this.abortController = controller
    void this.runTurn(controller.signal)
      .catch((error) => {
        this.emit({ type: "error", message: describeError(error) })
      })
      .finally(() => {
        this.abortController = undefined
        this.setState("idle")
      })
    return true
  }

  approve(scope: PermissionScope = "once", pattern?: string): void {
    this.resolveApproval({ decision: "allow", scope, pattern })
  }

  deny(cause: DenialCause = "user", message?: string): void {
    this.resolveApproval({ decision: "deny", cause, message })
  }

  interrupt(): void {
    this.abortController?.abort()
    this.resolveApproval({ decision: "deny", cause: "user" })
  }

  private resolveApproval(result: ApprovalResult): void {
    const resolve = this.pendingApproval
    if (!resolve) return
    this.pendingApproval = undefined
    if (result.pattern && result.scope && result.scope !== "once") {
      rememberRule(result.pattern, result.scope).catch((error) => {
        this.emit({ type: "error", message: describeError(error) })
      })
    }
    resolve(result)
  }

  private emit(event: AgentEvent): void {
    this.recorder?.event(event)
    this.notify(event)
  }

  private notify(event: AgentEvent): void {
    for (const listener of this.listeners) listener(event)
  }

  private pushItem(item: ConversationItem): void {
    this.items.push(item)
    this.recorder?.item(item)
  }

  private stream(kind: StreamKind, text: string): void {
    if (this.streaming && this.streaming.kind !== kind) this.flushStream()
    const streaming = this.streaming ?? { kind, text: "" }
    streaming.text += text
    this.streaming = streaming
    this.emit(kind === "assistant" ? { type: "text_delta", text } : { type: "reasoning_summary_delta", text })
  }

  private flushStream(): void {
    const streaming = this.streaming
    this.streaming = undefined
    if (!streaming || !streaming.text) return
    this.emit(
      streaming.kind === "assistant"
        ? { type: "assistant_message", text: streaming.text }
        : { type: "reasoning_summary", text: streaming.text },
    )
  }

  private setState(state: AgentState): void {
    if (this.state === state) return
    this.state = state
    this.emit({ type: "state_changed", state })
  }

  private addToolOutput(callId: string, output: string): void {
    this.pushItem({ type: "function_call_output", call_id: callId, output })
  }

  private async runTurn(signal: AbortSignal): Promise<void> {
    let lastUsage: Usage | undefined

    while (true) {
      const pendingItems: ConversationItem[] = []
      const toolCalls: PendingToolCall[] = []
      this.setState("streaming")

      try {
        for await (const event of this.provider.stream({
          model: this.model,
          instructions: composeSystemPrompt({
            appName: appInfo.name,
            platform: `${process.platform} ${release()}`,
            cwd: process.cwd(),
            tools: listTools(),
            mode: this.mode,
          }),
          input: this.items,
          tools: listTools().map(({ name, description, parameters }) => ({ name, description, parameters })),
          sessionId: this.id,
          signal,
        })) {
          switch (event.type) {
            case "text_delta":
              this.stream("assistant", event.text)
              break
            case "reasoning_summary_delta":
              this.stream("reasoning", event.text)
              break
            case "reasoning_delta":
              this.emit({ type: "reasoning_delta", text: event.text })
              break
            case "item_done":
              pendingItems.push(event.item)
              break
            case "tool_call":
              toolCalls.push({ callId: event.callId, name: event.name, args: event.args })
              break
            case "done":
              lastUsage = event.usage ?? lastUsage
              break
          }
        }
      } catch (error) {
        if (isAbortError(error) || signal.aborted) {
          this.flushStream()
          for (const item of pendingItems.filter((item) => item.type === "message")) this.pushItem(item)
          this.emit({ type: "turn_interrupted" })
          return
        }
        this.flushStream()
        throw error
      }

      this.flushStream()
      for (const item of pendingItems) this.pushItem(item)

      if (toolCalls.length === 0) {
        this.emit({ type: "turn_ended", usage: lastUsage })
        return
      }

      for (const call of toolCalls) {
        await this.handleToolCall(call, signal)
      }

      if (signal.aborted) {
        this.emit({ type: "turn_interrupted" })
        return
      }
    }
  }

  private async handleToolCall(call: PendingToolCall, signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
      this.addToolOutput(call.callId, "Interrupted by user before execution.")
      return
    }

    const tool = getTool(call.name)
    const title = tool?.title(call.args) ?? JSON.stringify(call.args)
    if (!tool) {
      const message = `Unknown tool: ${call.name}`
      this.addToolOutput(call.callId, message)
      this.emit({
        type: "tool_finished",
        callId: call.callId,
        tool: call.name,
        title,
        readOnly: false,
        output: message,
        denial: "policy",
      })
      return
    }

    const readOnly = tool.readOnly?.(call.args) ?? false
    const permission = tool.permission?.(call.args)
    const decision = await evaluatePolicy({
      tool: call.name,
      title,
      args: call.args,
      subject: permission?.subject,
      readOnly,
      mode: this.mode,
    })

    if (decision === "deny") {
      const cause = this.mode === "plan" && !readOnly ? "plan" : "policy"
      this.denyToolCall(call.callId, call.name, title, readOnly, cause)
      return
    }

    if (decision === "ask") {
      const asked = new Promise<ApprovalResult>((resolve) => {
        this.pendingApproval = resolve
      })
      this.setState("awaiting_approval")
      this.emit({
        type: "approval_requested",
        callId: call.callId,
        tool: call.name,
        title,
        readOnly,
        suggestion: permission?.suggestion,
      })
      const result = await asked
      if (result.decision === "deny") {
        this.denyToolCall(call.callId, call.name, title, readOnly, result.cause ?? "user", result.message)
        return
      }
    }

    this.setState("running_tool")
    this.emit({ type: "tool_started", callId: call.callId, tool: call.name, title, readOnly })
    let output: string
    try {
      output = (await tool.execute(call.args, signal)).output
    } catch (error) {
      output = `Tool failed: ${describeError(error)}`
    }
    this.addToolOutput(call.callId, output)
    this.emit({ type: "tool_finished", callId: call.callId, tool: call.name, title, readOnly, output })
  }

  private denyToolCall(
    callId: string,
    tool: string,
    title: string,
    readOnly: boolean,
    denial: DenialCause,
    message?: string,
  ): void {
    const output = message ?? denialMessages[denial]
    this.addToolOutput(callId, output)
    this.emit({ type: "tool_finished", callId, tool, title, readOnly, output, denial })
  }
}
