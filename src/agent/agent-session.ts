import { release } from "node:os"
import { dirname } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { appInfo } from "../app-info"
import { projectSessionsDir } from "../config/paths"
import { describeError } from "../lib/error"
import { rememberRule } from "../permissions/rules"
import { evaluatePolicy } from "../permissions/service"
import type { PermissionMode, PermissionScope } from "../permissions/types"
import { prepareConversation } from "../providers/conversation"
import { ProviderError } from "../providers/errors"
import type {
  ConversationItem,
  ProviderOutputItem,
  Provider,
  ThinkingEffort,
  ToolCallItem,
  UserInput,
  Usage,
} from "../providers/types"
import { SessionRecorder } from "../sessions/recorder"
import type { LoadedSession, SessionMeta } from "../sessions/types"
import { getTool, listTools } from "../tools/registry"
import { boundToolOutput, toolOutputDirectory } from "../tools/output"
import type { AgentEvent, AgentState, DenialCause } from "./events"
import { composeSystemPrompt } from "./prompt"

export interface AgentSessionDeps {
  provider: Provider
  model: string
  thinking?: ThinkingEffort
  persist?: boolean
}

export interface ResumeTarget {
  session: LoadedSession
  path: string
  provider: Provider
  model: string
  thinking?: ThinkingEffort
  mode: PermissionMode
}

type StreamKind = "assistant" | "reasoning"

const MAX_PROVIDER_ATTEMPTS = 3

interface ApprovalResult {
  decision: "allow" | "deny"
  scope?: PermissionScope
  pattern?: string
  cause?: DenialCause
  message?: string
}

interface StreamRound {
  received: boolean
  items: ProviderOutputItem[]
}

interface TurnUsage {
  turn?: Usage
  context?: Usage
}

const denialMessages: Record<DenialCause, string> = {
  user: "User denied permission to run this action.",
  policy: "Blocked by the active permission rules.",
  plan: "Plan mode is active, so this action was not run. Finish investigating and present a plan instead of retrying.",
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError"
}

function addUsage(total: Usage | undefined, usage: Usage): Usage {
  return {
    totalInputTokens: (total?.totalInputTokens ?? 0) + (usage.totalInputTokens ?? 0),
    cacheReadInputTokens: (total?.cacheReadInputTokens ?? 0) + (usage.cacheReadInputTokens ?? 0),
    cacheWriteInputTokens: (total?.cacheWriteInputTokens ?? 0) + (usage.cacheWriteInputTokens ?? 0),
    outputTokens: (total?.outputTokens ?? 0) + (usage.outputTokens ?? 0),
  }
}

export class AgentSession {
  private sessionId: string = crypto.randomUUID()
  private startedAt = Date.now()
  private items: ConversationItem[] = []
  private readonly listeners = new Set<(event: AgentEvent) => void>()
  private readonly recorder: SessionRecorder | undefined
  private outputDirectory: string
  private provider: Provider
  private model: string
  private thinking: ThinkingEffort | undefined
  private state: AgentState = "idle"
  private mode: PermissionMode = "build"
  private streaming: { kind: StreamKind; text: string } | undefined
  private abortController: AbortController | undefined
  private pendingApproval: ((result: ApprovalResult) => void) | undefined

  constructor(deps: AgentSessionDeps) {
    this.provider = deps.provider
    this.model = deps.model
    this.thinking = deps.thinking
    this.outputDirectory = toolOutputDirectory(projectSessionsDir(process.cwd()), this.sessionId)
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

  get currentThinking(): ThinkingEffort | undefined {
    return this.thinking
  }

  get hasModelOutput(): boolean {
    return this.items.some(
      (item) => item.type === "assistant_message" || item.type === "reasoning" || item.type === "tool_call",
    )
  }

  private meta(): SessionMeta {
    return {
      version: 1,
      id: this.sessionId,
      cwd: process.cwd(),
      provider: this.provider.id,
      model: this.model,
      thinking: this.thinking,
      mode: this.mode,
      startedAt: this.startedAt,
    }
  }

  reset(): boolean {
    if (this.state !== "idle") return false
    this.sessionId = crypto.randomUUID()
    this.outputDirectory = toolOutputDirectory(projectSessionsDir(process.cwd()), this.sessionId)
    this.startedAt = Date.now()
    this.items = []
    this.streaming = undefined
    this.recorder?.start(this.meta())
    this.emit({
      type: "session_started",
      id: this.sessionId,
      resumed: false,
      model: this.model,
      thinking: this.thinking,
      mode: this.mode,
    })
    return true
  }

  resume(target: ResumeTarget): boolean {
    if (this.state !== "idle") return false
    const { meta } = target.session
    this.sessionId = meta.id
    this.outputDirectory = toolOutputDirectory(dirname(target.path), this.sessionId)
    this.startedAt = meta.startedAt
    this.items = [...target.session.items]
    this.streaming = undefined
    this.provider = target.provider
    this.model = target.model
    this.thinking = target.thinking
    this.mode = target.mode
    this.recorder?.attach(target.path)
    this.emit({
      type: "session_started",
      id: this.sessionId,
      resumed: true,
      model: this.model,
      thinking: this.thinking,
      mode: this.mode,
    })
    for (const event of target.session.events) this.notify(event)
    return true
  }

  setModel(provider: Provider, model: string, thinking?: ThinkingEffort): boolean {
    if (this.state !== "idle") return false
    if (this.provider === provider && this.model === model) return this.setThinking(thinking)
    this.provider = provider
    this.model = model
    this.thinking = thinking
    this.emit({ type: "model_changed", provider: provider.id, model })
    this.emit({ type: "thinking_changed", thinking })
    return true
  }

  setThinking(thinking?: ThinkingEffort): boolean {
    if (this.state !== "idle") return false
    if (this.thinking === thinking) return true
    this.thinking = thinking
    this.emit({ type: "thinking_changed", thinking })
    return true
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

  send(input: UserInput): boolean {
    if (this.state !== "idle") return false
    if (input.images.length > 0 && !this.provider.capabilities.imageInput) {
      this.emit({ type: "error", message: `${this.provider.name} does not support image input` })
      return false
    }
    this.pushItem({ type: "user_message", ...input })
    this.emit({ type: "user_message", text: input.text, imageCount: input.images.length, sentAt: Date.now() })
    const controller = new AbortController()
    const provider = this.provider
    const model = this.model
    const thinking = this.thinking
    this.abortController = controller
    void this.runTurn(controller.signal, provider, model, thinking)
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

  private addToolOutput(call: ToolCallItem, output: string, isError: boolean): void {
    this.pushItem({ type: "tool_result", callId: call.callId, name: call.name, output, isError })
  }

  private async runTurn(
    signal: AbortSignal,
    provider: Provider,
    model: string,
    thinking: ThinkingEffort | undefined,
  ): Promise<void> {
    const usage: TurnUsage = {}

    while (true) {
      this.setState("streaming")
      const items = await this.streamRound(signal, provider, model, thinking, usage)
      if (!items) return

      this.flushStream()
      for (const item of items) this.pushItem(item)

      const toolCalls = items.filter((item): item is ToolCallItem => item.type === "tool_call")
      if (toolCalls.length === 0) {
        this.emit({ type: "turn_ended", usage: usage.turn, context: usage.context })
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

  private async streamRound(
    signal: AbortSignal,
    provider: Provider,
    model: string,
    thinking: ThinkingEffort | undefined,
    usage: TurnUsage,
  ): Promise<ProviderOutputItem[] | undefined> {
    let attempt = 1

    while (true) {
      const round: StreamRound = { received: false, items: [] }
      try {
        await this.consumeStream(signal, provider, model, thinking, round, usage)
        return round.items
      } catch (error) {
        if (isAbortError(error) || signal.aborted) {
          this.flushStream()
          for (const item of round.items.filter((item) => item.type === "assistant_message")) this.pushItem(item)
          this.emit({ type: "turn_interrupted" })
          return undefined
        }
        if (
          !(error instanceof ProviderError) ||
          !error.retryable ||
          round.received ||
          attempt >= MAX_PROVIDER_ATTEMPTS
        ) {
          this.flushStream()
          throw error
        }

        const delayMs = error.retryAfterMs ?? 1_000 * 2 ** (attempt - 1)
        attempt += 1
        this.emit({
          type: "retry_scheduled",
          attempt,
          maxAttempts: MAX_PROVIDER_ATTEMPTS,
          delayMs,
          message: error.message,
        })
        try {
          await sleep(delayMs, undefined, { signal })
        } catch (waitError) {
          if (!isAbortError(waitError) && !signal.aborted) throw waitError
          this.emit({ type: "turn_interrupted" })
          return undefined
        }
      }
    }
  }

  private async consumeStream(
    signal: AbortSignal,
    provider: Provider,
    model: string,
    thinking: ThinkingEffort | undefined,
    round: StreamRound,
    usage: TurnUsage,
  ): Promise<void> {
    for await (const event of provider.stream({
      model,
      thinking,
      instructions: composeSystemPrompt({
        appName: appInfo.name,
        platform: `${process.platform} ${release()}`,
        cwd: process.cwd(),
        tools: listTools(),
        mode: this.mode,
      }),
      input: prepareConversation(this.items, { provider: provider.id, model }),
      tools: listTools().map(({ name, description, parameters }) => ({ name, description, parameters })),
      sessionId: this.id,
      signal,
    })) {
      round.received = true
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
          round.items.push(event.item)
          break
        case "done": {
          if (!event.usage) break
          usage.context = event.usage
          usage.turn = addUsage(usage.turn, event.usage)
          break
        }
      }
    }
  }

  private async handleToolCall(call: ToolCallItem, signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
      this.addToolOutput(call, "Interrupted by user before execution.", true)
      return
    }

    const tool = getTool(call.name)
    const title = tool?.title(call.args) ?? JSON.stringify(call.args)
    if (!tool) {
      const message = `Unknown tool: ${call.name}`
      this.addToolOutput(call, message, true)
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
      this.denyToolCall(call, title, readOnly, cause)
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
        this.denyToolCall(call, title, readOnly, result.cause ?? "user", result.message)
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
      this.addToolOutput(call, output, true)
      this.emit({ type: "tool_finished", callId: call.callId, tool: call.name, title, readOnly, output })
      return
    }
    let isError = false
    try {
      output = await boundToolOutput(this.outputDirectory, output)
    } catch (error) {
      output = `Tool completed, but its output could not be saved: ${describeError(error)}. The operation may have changed state; inspect it before retrying.`
      isError = true
    }
    this.addToolOutput(call, output, isError)
    this.emit({ type: "tool_finished", callId: call.callId, tool: call.name, title, readOnly, output })
  }

  private denyToolCall(
    call: ToolCallItem,
    title: string,
    readOnly: boolean,
    denial: DenialCause,
    message?: string,
  ): void {
    const output = message ?? denialMessages[denial]
    this.addToolOutput(call, output, true)
    this.emit({ type: "tool_finished", callId: call.callId, tool: call.name, title, readOnly, output, denial })
  }
}
