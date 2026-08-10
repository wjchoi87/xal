import { release } from "node:os"
import { dirname, resolve } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { appInfo } from "../app-info"
import { projectSessionsDir } from "../config/paths"
import { describeError } from "../lib/error"
import { rememberRule } from "../permissions/rules"
import { evaluatePolicy } from "../permissions/service"
import type { PermissionMode, PermissionScope } from "../permissions/types"
import type { SessionPlan } from "../plans/types"
import { contextWindow } from "../providers/catalog"
import { prepareConversation } from "../providers/conversation"
import { ProviderError } from "../providers/errors"
import { occupiedContext } from "../providers/types"
import type {
  ModelInputModality,
  ProviderOutputItem,
  Provider,
  ThinkingEffort,
  ToolCallItem,
  UserInput,
  UserMessageItem,
  Usage,
} from "../providers/types"
import { SessionRecorder } from "../sessions/recorder"
import { normalizeSessionTitle, titleFromInput } from "../sessions/title"
import type { LoadedSession, SessionMeta } from "../sessions/types"
import { expandSkillInvocation } from "../skills/invoke"
import { getTool, listTools } from "../tools/registry"
import { boundToolOutput, TOOL_FAILED_PREFIX, TOOL_OUTPUT_UNSAVED_PREFIX, toolOutputDirectory } from "../tools/output"
import { isInteractiveTool, isSessionTool, MAX_ELICITATION_ANSWER_LENGTH } from "../tools/types"
import type {
  ElicitationAnswer,
  ElicitationRequest,
  ElicitationResult,
  RegisteredTool,
  ToolConcurrency,
  ToolEvent,
} from "../tools/types"
import {
  COMPACTION_TRIGGER_RATIO,
  estimateHistoryTokens,
  splitForCompaction,
  summarizeHistory,
  tailBudget,
} from "./compaction"
import type { CompactionTrigger } from "./compaction"
import type { AgentEvent, AgentState, DenialCause, QueuedEntry, SessionStartedEvent } from "./events"
import { activeHistory, type HistoryItem } from "./history"
import { OutputLoopDetector, ToolLoopDetector, type OutputLoop, type ToolLoopAction } from "./loop-detection"
import { OutputContract, type OutputSchema } from "./output-contract"
import { composeSystemPrompt } from "./prompt"
import type { SessionKind } from "./types"

export interface AgentSessionDeps {
  kind?: SessionKind
  cwd?: string
  provider: Provider
  model: string
  modelInputModalities?: ModelInputModality[]
  thinking?: ThinkingEffort
  persist?: boolean
  interactive?: boolean
  outputSchema?: OutputSchema
}

export interface ResumeTarget {
  session: LoadedSession
  path: string
  cwd: string
  provider: Provider
  model: string
  modelInputModalities?: ModelInputModality[]
  thinking?: ThinkingEffort
  mode: PermissionMode
}

type StreamKind = "assistant" | "reasoning"

export type CompactionOutcome = "compacted" | "nothing" | "busy" | "interrupted"

const MAX_PROVIDER_ATTEMPTS = 3
const MAX_COMPACTION_FAILURES = 2

interface ApprovalResult {
  decision: "allow" | "deny"
  scope?: PermissionScope
  pattern?: string
  cause?: DenialCause
  message?: string
}

interface PendingElicitation {
  requestId: string
  callId: string
  request: ElicitationRequest
  resolve(result: ElicitationResult): void
}

interface StreamRound {
  received: boolean
  items: ProviderOutputItem[]
}

interface TurnUsage {
  turn?: Usage
  context?: Usage
}

interface ToolCallBatch {
  concurrency: ToolConcurrency
  calls: ToolCallItem[]
}

interface PreparedToolCall {
  call: ToolCallItem
  tool: RegisteredTool
  title: string
  readOnly: boolean
}

interface ToolCallOutcome {
  call: ToolCallItem
  title: string
  readOnly: boolean
  output: string
  events: ToolEvent[]
  denial?: DenialCause
}

type ToolCallPreparation = { type: "ready"; prepared: PreparedToolCall } | { type: "outcome"; outcome: ToolCallOutcome }

const denialMessages: Record<DenialCause, string> = {
  user: "User denied permission to run this action.",
  policy: "Blocked by the active permission rules.",
  plan: "Plan mode is active, so this action was not run. Finish investigating and present a plan instead of retrying.",
}

const subagentPlanDenial =
  "This delegation is read-only, so this action was not run. Continue with read-only tools and report your findings."

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

function recordedContext(events: AgentEvent[]): number | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!
    if (event.type === "compacted") return undefined
    if (event.type === "turn_ended" && event.context) return occupiedContext(event.context)
  }
  return undefined
}

export class AgentSession {
  private sessionId: string = crypto.randomUUID()
  private title: string | undefined
  private startedAt = Date.now()
  private items: HistoryItem[] = []
  private contextTokens: number | undefined
  private compactionFailures = 0
  private readonly listeners = new Set<(event: AgentEvent) => void>()
  private readonly recorder: SessionRecorder | undefined
  private readonly interactive: boolean
  private readonly kind: SessionKind
  private readonly outputContract: OutputContract | undefined
  private outputDirectory: string
  private cwd: string
  private provider: Provider
  private model: string
  private modelInputModalities: ModelInputModality[] | undefined
  private thinking: ThinkingEffort | undefined
  private state: AgentState = "idle"
  private mode: PermissionMode = "build"
  private plan: SessionPlan | undefined
  private planHandoffActive = false
  private streaming: { kind: StreamKind; text: string } | undefined
  private abortController: AbortController | undefined
  private pendingApproval: ((result: ApprovalResult) => void) | undefined
  private pendingElicitation: PendingElicitation | undefined
  private queued: UserInput[] = []
  private turnActive = false
  private promoteOnAbort = false

  constructor(deps: AgentSessionDeps) {
    this.kind = deps.kind ?? "primary"
    this.cwd = resolve(deps.cwd ?? process.cwd())
    this.provider = deps.provider
    this.model = deps.model
    this.modelInputModalities = deps.modelInputModalities
    this.thinking = deps.thinking
    this.interactive = deps.interactive ?? false
    this.outputContract = deps.outputSchema ? new OutputContract(deps.outputSchema) : undefined
    this.outputDirectory = toolOutputDirectory(projectSessionsDir(this.cwd), this.sessionId)
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

  get currentWorkingDirectory(): string {
    return this.cwd
  }

  get currentPlan(): SessionPlan | undefined {
    return this.plan
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

  get supportsImageInput(): boolean {
    if (!this.provider.capabilities.imageInput) return false
    return this.modelInputModalities?.includes("image") ?? true
  }

  startEvent(resumed = false): SessionStartedEvent {
    return {
      type: "session_started",
      id: this.sessionId,
      resumed,
      title: this.title,
      provider: this.provider.id,
      model: this.model,
      thinking: this.thinking,
      mode: this.mode,
      cwd: this.cwd,
    }
  }

  get hasModelOutput(): boolean {
    return this.items.some(
      (item) =>
        item.type === "assistant_message" ||
        item.type === "reasoning" ||
        item.type === "tool_call" ||
        item.type === "compaction",
    )
  }

  private meta(): SessionMeta {
    return {
      version: 1,
      id: this.sessionId,
      cwd: this.cwd,
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
    this.title = undefined
    this.outputDirectory = toolOutputDirectory(projectSessionsDir(this.cwd), this.sessionId)
    this.startedAt = Date.now()
    this.items = []
    this.contextTokens = undefined
    this.compactionFailures = 0
    this.plan = undefined
    this.planHandoffActive = false
    this.streaming = undefined
    this.recorder?.start(this.meta())
    this.emit(this.startEvent())
    return true
  }

  resume(target: ResumeTarget): boolean {
    if (this.state !== "idle") return false
    const { meta } = target.session
    this.sessionId = meta.id
    this.title = target.session.title
    this.outputDirectory = toolOutputDirectory(dirname(target.path), this.sessionId)
    this.cwd = resolve(target.cwd)
    this.startedAt = meta.startedAt
    this.items = [...target.session.items]
    this.contextTokens = recordedContext(target.session.events)
    this.compactionFailures = 0
    this.plan = undefined
    this.planHandoffActive = false
    let recordedCwd = meta.cwd
    for (const event of target.session.events) {
      if (event.type === "plan_updated") {
        this.plan = event.plan
        this.planHandoffActive = event.plan.status === "approved"
      }
      if (event.type === "mode_changed" && event.mode === "plan") this.planHandoffActive = false
      if (event.type === "turn_ended") this.planHandoffActive = false
      if (event.type === "workspace_changed") recordedCwd = event.cwd
    }
    this.streaming = undefined
    this.provider = target.provider
    this.model = target.model
    this.modelInputModalities = target.modelInputModalities
    this.thinking = target.thinking
    this.mode = target.mode
    this.recorder?.attach(target.path)
    this.emit(this.startEvent(true))
    for (const event of target.session.events) this.notify(event)
    if (resolve(recordedCwd) !== this.cwd) {
      this.notify({ type: "workspace_changed", cwd: this.cwd, previous: recordedCwd })
    }
    return true
  }

  setModel(
    provider: Provider,
    model: string,
    thinking?: ThinkingEffort,
    inputModalities?: ModelInputModality[],
  ): boolean {
    if (this.state !== "idle") return false
    if (this.provider === provider && this.model === model) {
      this.modelInputModalities = inputModalities
      return this.setThinking(thinking)
    }
    this.provider = provider
    this.model = model
    this.modelInputModalities = inputModalities
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
    if (mode === "plan") this.planHandoffActive = false
    this.emit({ type: "mode_changed", mode })
  }

  changeWorkspace(cwd: string): void {
    const next = resolve(cwd)
    if (next === this.cwd) return
    const previous = this.cwd
    this.cwd = next
    this.emit({ type: "workspace_changed", cwd: next, previous })
  }

  setTitle(input: string): string | undefined {
    const title = normalizeSessionTitle(input)
    if (!title) return undefined
    if (title === this.title) return title
    this.title = title
    this.emit({ type: "session_title_changed", title })
    return title
  }

  subscribe(listener: (event: AgentEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  send(input: UserInput): boolean {
    if (input.images.length > 0 && !this.supportsImageInput) {
      this.emit({ type: "error", message: `${this.model} does not support image input` })
      return false
    }
    if (this.turnActive) {
      this.queued.push(input)
      this.emit({ type: "queue_changed", entries: this.queueEntries() })
      return true
    }
    if (this.state !== "idle") return false
    this.startTurn([input])
    return true
  }

  private startTurn(inputs: UserInput[]): void {
    this.outputContract?.reset()
    for (const input of inputs) {
      this.ensureTitle(input)
      this.pushItem(this.userMessage(input))
      this.emit({ type: "user_message", text: input.text, imageCount: input.images.length, sentAt: Date.now() })
    }
    const controller = new AbortController()
    const provider = this.provider
    const model = this.model
    const thinking = this.thinking
    this.abortController = controller
    this.turnActive = true
    this.promoteOnAbort = false
    this.setState("streaming")
    let errored = false
    void this.runTurn(controller.signal, provider, model, thinking)
      .catch((error) => {
        errored = true
        this.emit({ type: "turn_failed", message: describeError(error) })
      })
      .finally(() => {
        this.turnActive = false
        this.abortController = undefined
        this.setState("idle")
        if (!errored && controller.signal.aborted && this.promoteOnAbort && this.queued.length > 0) {
          const promoted = this.queued.splice(0)
          this.emit({ type: "queue_changed", entries: [] })
          this.startTurn(promoted)
          return
        }
        this.flushQueue()
      })
  }

  private queueEntries(): QueuedEntry[] {
    return this.queued.map((input) => ({ text: input.text, imageCount: input.images.length }))
  }

  private drainQueue(): boolean {
    if (this.queued.length === 0) return false
    for (const input of this.queued.splice(0)) {
      this.ensureTitle(input)
      this.pushItem(this.userMessage(input))
      this.emit({ type: "user_message", text: input.text, imageCount: input.images.length, sentAt: Date.now() })
    }
    this.emit({ type: "queue_changed", entries: [] })
    return true
  }

  private ensureTitle(input: UserInput): void {
    if (this.title) return
    const title = titleFromInput(input.text, input.images.length)
    if (title) this.setTitle(title)
  }

  private userMessage(input: UserInput): UserMessageItem {
    const modelText = expandSkillInvocation(input.text)
    return modelText ? { type: "user_message", ...input, modelText } : { type: "user_message", ...input }
  }

  private flushQueue(): void {
    if (this.queued.length === 0) return
    const inputs = this.queued.splice(0)
    this.emit({ type: "queue_changed", entries: [] })
    this.emit({ type: "queue_flushed", inputs })
  }

  async compact(instructions?: string): Promise<CompactionOutcome> {
    if (this.state !== "idle") return "busy"
    const controller = new AbortController()
    this.abortController = controller
    this.setState("compacting")
    try {
      const compacted = await this.runCompaction(
        controller.signal,
        this.provider,
        this.model,
        this.thinking,
        "manual",
        instructions,
      )
      return compacted ? "compacted" : "nothing"
    } catch (error) {
      if (!isAbortError(error) && !controller.signal.aborted) throw error
      return "interrupted"
    } finally {
      this.abortController = undefined
      this.setState("idle")
    }
  }

  approve(scope: PermissionScope = "once", pattern?: string): void {
    this.resolveApproval({ decision: "allow", scope, pattern })
  }

  deny(cause: DenialCause = "user", message?: string): void {
    this.resolveApproval({ decision: "deny", cause, message })
  }

  answerElicitation(requestId: string, answers: ElicitationAnswer[]): boolean {
    const pending = this.pendingElicitation
    if (!pending || pending.requestId !== requestId) return false

    const byQuestion = new Map(answers.map((answer) => [answer.questionId, answer.value.trim()]))
    if (byQuestion.size !== answers.length || byQuestion.size !== pending.request.questions.length) return false
    if ([...byQuestion.values()].some((value) => !value || value.length > MAX_ELICITATION_ANSWER_LENGTH)) return false

    const normalized = pending.request.questions.flatMap((question): ElicitationAnswer[] => {
      const value = byQuestion.get(question.id)
      return value === undefined ? [] : [{ questionId: question.id, value }]
    })
    if (normalized.length !== pending.request.questions.length) return false

    this.resolveElicitation({ status: "answered", answers: normalized })
    return true
  }

  rejectElicitation(requestId: string): boolean {
    if (this.pendingElicitation?.requestId !== requestId) return false
    this.resolveElicitation({ status: "rejected" })
    return true
  }

  interrupt(queued: "promote" | "flush" = "flush"): void {
    this.promoteOnAbort = queued === "promote"
    this.abortController?.abort()
    this.resolveApproval({ decision: "deny", cause: "user" })
    this.resolveElicitation({ status: "rejected" })
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

  private resolveElicitation(result: ElicitationResult): void {
    const pending = this.pendingElicitation
    if (!pending) return
    this.pendingElicitation = undefined
    this.emit({ type: "elicitation_resolved", callId: pending.callId })
    pending.resolve(result)
  }

  private async requestInput(
    callId: string,
    request: ElicitationRequest,
    signal: AbortSignal,
  ): Promise<ElicitationResult> {
    if (!this.interactive) throw new Error("user input is unavailable without an interactive client")
    if (this.pendingElicitation) throw new Error("another user input request is already pending")
    if (signal.aborted) return { status: "rejected" }

    const requestId = crypto.randomUUID()
    const result = await new Promise<ElicitationResult>((resolve) => {
      this.pendingElicitation = { requestId, callId, request, resolve }
      this.setState("awaiting_input")
      this.emit({ type: "elicitation_requested", requestId, callId, questions: request.questions })
    })
    if (!signal.aborted) this.setState("running_tool")
    return result
  }

  private availableTools(): RegisteredTool[] {
    const tools = listTools().filter((tool) => this.canUseTool(tool))
    const contract = this.outputContract
    if (!contract) return tools
    return [...tools.filter((tool) => tool.name !== contract.tool.name), contract.tool]
  }

  private availableTool(name: string): RegisteredTool | undefined {
    if (this.outputContract?.tool.name === name) return this.outputContract.tool
    const tool = getTool(name)
    if (!tool || !this.canUseTool(tool)) return undefined
    return tool
  }

  private canUseTool(tool: RegisteredTool): boolean {
    if (!this.interactive && isInteractiveTool(tool)) return false
    return tool.available?.({ interactive: this.interactive, kind: this.kind, mode: this.mode }) ?? true
  }

  private emit(event: AgentEvent): void {
    this.recorder?.event(event)
    this.notify(event)
    if (event.type === "turn_ended") this.planHandoffActive = false
  }

  private notify(event: AgentEvent): void {
    for (const listener of this.listeners) listener(event)
  }

  private pushItem(item: HistoryItem): void {
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

  private addToolOutput(call: ToolCallItem, output: string): void {
    this.pushItem({ type: "tool_result", callId: call.callId, output })
  }

  private async runCompaction(
    signal: AbortSignal,
    provider: Provider,
    model: string,
    thinking: ThinkingEffort | undefined,
    trigger: CompactionTrigger,
    instructions?: string,
  ): Promise<boolean> {
    const budget = tailBudget(await contextWindow(provider, model), trigger)
    const { head, tail, replaced } = splitForCompaction(this.items, budget)
    if (head.length === 0) return false

    this.setState("compacting")
    const summary = await summarizeHistory({
      provider,
      model,
      thinking,
      sessionId: this.sessionId,
      history: head,
      instructions,
      signal,
    })

    const tokensBefore = this.contextTokens
    this.items = []
    this.pushItem({ type: "compaction", summary, replaced, tokensBefore, retained: tail })
    this.contextTokens = undefined
    this.compactionFailures = 0
    this.emit({ type: "compacted", summary, replaced, tokensBefore })
    return true
  }

  private async autoCompact(
    signal: AbortSignal,
    provider: Provider,
    model: string,
    thinking: ThinkingEffort | undefined,
  ): Promise<void> {
    if (this.compactionFailures >= MAX_COMPACTION_FAILURES) return
    const tokens = this.contextTokens ?? estimateHistoryTokens(activeHistory(this.items))
    const window = await contextWindow(provider, model)
    if (window === undefined || tokens < window * COMPACTION_TRIGGER_RATIO) return

    try {
      await this.runCompaction(signal, provider, model, thinking, "auto")
    } catch (error) {
      if (isAbortError(error) || signal.aborted) return
      this.compactionFailures += 1
      this.emit({
        type: "error",
        message: `context compaction failed: ${describeError(error)} — run /compact to retry`,
      })
    }
  }

  private async runTurn(
    signal: AbortSignal,
    provider: Provider,
    model: string,
    thinking: ThinkingEffort | undefined,
  ): Promise<void> {
    const usage: TurnUsage = {}
    const toolLoops = new ToolLoopDetector()

    while (true) {
      await this.autoCompact(signal, provider, model, thinking)
      if (signal.aborted) {
        this.emit({ type: "turn_interrupted" })
        return
      }
      if (this.drainQueue()) toolLoops.reset()

      this.setState("streaming")
      const items = await this.streamRound(signal, provider, model, thinking, usage)
      if (!items) return

      this.flushStream()
      for (const item of items) this.pushItem(item)

      const toolCalls = items.filter((item): item is ToolCallItem => item.type === "tool_call")
      if (toolCalls.length === 0) {
        if (this.queued.length > 0) continue
        if (this.outputContract) {
          const correction = this.outputContract.missing()
          if (this.outputContract.exhausted) throw this.outputContract.failure()
          this.pushItem({ type: "user_message", text: correction, images: [] })
          continue
        }
        this.emit({ type: "turn_ended", usage: usage.turn, context: usage.context })
        return
      }

      let loopError: Error | undefined
      const batches = this.toolCallBatches(toolCalls)
      for (const [index, batch] of batches.entries()) {
        if (loopError) {
          for (const call of batch.calls) {
            this.finishSkippedToolCall(call, "Not run because a repeated tool loop stopped the turn.")
          }
          continue
        }
        loopError = await this.runToolCallBatch(batch, signal, toolLoops)
        if (!this.outputContract?.output && !this.outputContract?.exhausted) continue
        for (const remaining of batches.slice(index + 1)) {
          for (const call of remaining.calls) {
            this.finishSkippedToolCall(call, "Not run because structured output ended the turn.")
          }
        }
        break
      }
      if (loopError) throw loopError
      if (this.outputContract?.output) {
        this.emit({
          type: "turn_ended",
          usage: usage.turn,
          context: usage.context,
          output: this.outputContract.output,
        })
        return
      }
      if (this.outputContract?.exhausted) throw this.outputContract.failure()

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
    const tools = this.availableTools()
    const outputLoops = {
      assistant: new OutputLoopDetector(),
      reasoning: new OutputLoopDetector(),
      rawReasoning: new OutputLoopDetector(),
    }
    let assistantStreamed = false
    let reasoningStreamed = false

    const rejectLoop = (loop: OutputLoop | undefined, label: string): void => {
      if (!loop) return
      const description = loop === "repeated" ? "repeated text" : "low-novelty text"
      throw new ProviderError(`model output loop detected in ${label}: ${description}`, { retryable: true })
    }
    const detectLoop = (detector: OutputLoopDetector, text: string, label: string): void => {
      rejectLoop(detector.add(text), label)
    }
    const finishLoop = (detector: OutputLoopDetector, label: string): void => {
      rejectLoop(detector.finish(), label)
    }

    for await (const event of provider.stream({
      model,
      thinking,
      instructions: composeSystemPrompt({
        appName: appInfo.name,
        platform: `${process.platform} ${release()}`,
        cwd: this.cwd,
        kind: this.kind,
        tools,
        mode: this.mode,
        plan: this.mode === "plan" || this.planHandoffActive ? this.plan : undefined,
      }),
      input: prepareConversation(activeHistory(this.items), { provider: provider.id, model }),
      tools: tools.map(({ name, description, parameters }) => ({ name, description, parameters })),
      sessionId: this.id,
      signal,
    })) {
      round.received = true
      switch (event.type) {
        case "text_delta":
          detectLoop(outputLoops.assistant, event.text, "assistant response")
          assistantStreamed = true
          this.stream("assistant", event.text)
          break
        case "reasoning_summary_delta":
          detectLoop(outputLoops.reasoning, event.text, "reasoning summary")
          reasoningStreamed = true
          this.stream("reasoning", event.text)
          break
        case "reasoning_delta":
          detectLoop(outputLoops.rawReasoning, event.text, "reasoning")
          this.emit({ type: "reasoning_delta", text: event.text })
          break
        case "item_done": {
          if (event.item.type === "assistant_message") {
            if (!assistantStreamed) {
              detectLoop(outputLoops.assistant, event.item.text, "assistant response")
              if (event.item.text) this.emit({ type: "assistant_message", text: event.item.text })
            }
            finishLoop(outputLoops.assistant, "assistant response")
            assistantStreamed = false
          }
          if (event.item.type === "reasoning") {
            if (!reasoningStreamed) {
              detectLoop(outputLoops.reasoning, event.item.summary, "reasoning summary")
              if (event.item.summary) this.emit({ type: "reasoning_summary", text: event.item.summary })
            }
            finishLoop(outputLoops.reasoning, "reasoning summary")
            reasoningStreamed = false
          }
          round.items.push(event.item)
          break
        }
        case "done": {
          finishLoop(outputLoops.assistant, "assistant response")
          finishLoop(outputLoops.reasoning, "reasoning summary")
          finishLoop(outputLoops.rawReasoning, "reasoning")
          if (!event.usage) break
          usage.context = event.usage
          usage.turn = addUsage(usage.turn, event.usage)
          this.contextTokens = occupiedContext(event.usage)
          break
        }
      }
    }
  }

  private toolCallBatches(calls: ToolCallItem[]): ToolCallBatch[] {
    const batches: ToolCallBatch[] = []
    for (const call of calls) {
      const tool = this.availableTool(call.name)
      const concurrency = tool?.concurrency?.(call.args, { cwd: this.cwd }) ?? "exclusive"
      const previous = batches.at(-1)
      if (concurrency === "shared" && previous?.concurrency === "shared") {
        previous.calls.push(call)
        continue
      }
      batches.push({ concurrency, calls: [call] })
    }
    return batches
  }

  private toolCallOutcome(
    call: ToolCallItem,
    title: string,
    readOnly: boolean,
    output: string,
    denial?: DenialCause,
    events: ToolEvent[] = [],
  ): ToolCallOutcome {
    return { call, title, readOnly, output, events, ...(denial ? { denial } : {}) }
  }

  private toolLoopOutcome(call: ToolCallItem, action: Exclude<ToolLoopAction, "allow">): ToolCallOutcome {
    const output =
      action === "steer"
        ? `Repeated tool call blocked: ${call.name} returned the same result twice for identical arguments. Use the existing result or change the approach.`
        : `Repeated tool call blocked again: ${call.name} was requested with the same arguments after the loop warning.`
    return this.skippedToolCallOutcome(call, output)
  }

  private skippedToolCallOutcome(call: ToolCallItem, output: string): ToolCallOutcome {
    const tool = this.availableTool(call.name)
    const title = tool?.title(call.args, { cwd: this.cwd }) ?? JSON.stringify(call.args)
    const readOnly = tool?.readOnly?.(call.args, { cwd: this.cwd }) ?? false
    return this.toolCallOutcome(call, title, readOnly, output)
  }

  private finishSkippedToolCall(call: ToolCallItem, output: string): void {
    this.commitToolCall(this.skippedToolCallOutcome(call, output))
  }

  private async runToolCallBatch(
    batch: ToolCallBatch,
    signal: AbortSignal,
    toolLoops: ToolLoopDetector,
  ): Promise<Error | undefined> {
    const outcomes: Array<ToolCallOutcome | undefined> = batch.calls.map(() => undefined)
    const ready: Array<{ index: number; prepared: PreparedToolCall }> = []
    const recorded = batch.calls.map(() => false)
    let loopError: Error | undefined

    for (const [index, call] of batch.calls.entries()) {
      if (loopError) {
        outcomes[index] = this.skippedToolCallOutcome(call, "Not run because a repeated tool loop stopped the turn.")
        continue
      }

      const loop = signal.aborted ? "allow" : toolLoops.inspect(call)
      if (loop !== "allow") {
        outcomes[index] = this.toolLoopOutcome(call, loop)
        if (loop === "stop") loopError = new Error(`turn stopped after repeated ${call.name} tool calls`)
        continue
      }

      recorded[index] = true
      const preparation = await this.prepareToolCall(call, signal)
      if (preparation.type === "outcome") {
        outcomes[index] = preparation.outcome
        continue
      }
      ready.push({ index, prepared: preparation.prepared })
    }

    if (batch.concurrency === "shared") {
      const completed = await Promise.all(ready.map(({ prepared }) => this.executeToolCall(prepared, signal)))
      completed.forEach((outcome, index) => {
        const entry = ready[index]
        if (!entry) throw new Error("tool scheduler lost a shared call")
        outcomes[entry.index] = outcome
      })
    } else {
      for (const entry of ready) outcomes[entry.index] = await this.executeToolCall(entry.prepared, signal)
    }

    for (const [index, outcome] of outcomes.entries()) {
      if (!outcome) throw new Error("tool scheduler did not produce a result")
      this.commitToolCall(outcome)
      if (recorded[index]) toolLoops.record(outcome.call, outcome.output)
    }
    return loopError
  }

  private async prepareToolCall(call: ToolCallItem, signal: AbortSignal): Promise<ToolCallPreparation> {
    const tool = this.availableTool(call.name)
    const title = tool?.title(call.args, { cwd: this.cwd }) ?? JSON.stringify(call.args)
    const readOnly = tool?.readOnly?.(call.args, { cwd: this.cwd }) ?? false

    if (signal.aborted) {
      return {
        type: "outcome",
        outcome: this.toolCallOutcome(call, title, readOnly, "Interrupted by user before execution."),
      }
    }

    if (!tool) {
      return {
        type: "outcome",
        outcome: this.toolCallOutcome(call, title, false, `Unknown tool: ${call.name}`, "policy"),
      }
    }

    const sandboxed = tool.sandboxed?.(call.args, { cwd: this.cwd }) ?? false
    const permission = tool.permission?.(call.args, { cwd: this.cwd })
    const decision = await evaluatePolicy({
      tool: call.name,
      title,
      args: call.args,
      subject: permission?.subject,
      readOnly,
      sandboxed,
      mode: this.mode,
    })

    if (decision === "deny") {
      const cause = this.mode === "plan" && !readOnly ? "plan" : "policy"
      const message = cause === "plan" && this.kind === "subagent" ? subagentPlanDenial : denialMessages[cause]
      return {
        type: "outcome",
        outcome: this.toolCallOutcome(call, title, readOnly, message, cause),
      }
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
        const denial = result.cause ?? "user"
        return {
          type: "outcome",
          outcome: this.toolCallOutcome(call, title, readOnly, result.message ?? denialMessages[denial], denial),
        }
      }
    }

    return { type: "ready", prepared: { call, tool, title, readOnly } }
  }

  private async executeToolCall(prepared: PreparedToolCall, signal: AbortSignal): Promise<ToolCallOutcome> {
    const { call, tool, title, readOnly } = prepared
    if (signal.aborted) {
      return this.toolCallOutcome(call, title, readOnly, "Interrupted by user before execution.")
    }

    this.setState("running_tool")
    this.emit({ type: "tool_started", callId: call.callId, tool: call.name, title, readOnly })
    let output: string
    let events: ToolEvent[]
    try {
      const update = (text: string): void => this.emit({ type: "tool_updated", callId: call.callId, text })
      const result = isInteractiveTool(tool)
        ? await tool.execute(call.args, {
            session: { directory: this.outputDirectory, mode: this.mode },
            publish: (event) => this.publishToolEvent(event),
            requestInput: (request) => this.requestInput(call.callId, request, signal),
          })
        : isSessionTool(tool)
          ? await tool.execute(call.args, {
              session: {
                kind: this.kind,
                cwd: this.cwd,
                provider: this.provider,
                model: this.model,
                modelInputModalities: this.modelInputModalities,
                thinking: this.thinking,
                mode: this.mode,
                changeWorkspace: (cwd) => this.changeWorkspace(cwd),
              },
              signal,
              update,
            })
          : await tool.execute(call.args, { cwd: this.cwd, signal, update })
      output = result.output
      events = result.events ?? []
    } catch (error) {
      output = `${TOOL_FAILED_PREFIX}${describeError(error)}`
      return this.toolCallOutcome(call, title, readOnly, output)
    }
    try {
      output = await boundToolOutput(this.outputDirectory, output)
    } catch (error) {
      output = `${TOOL_OUTPUT_UNSAVED_PREFIX}${describeError(error)}. The operation may have changed state; inspect it before retrying.`
    }
    return this.toolCallOutcome(call, title, readOnly, output, undefined, events)
  }

  private commitToolCall(outcome: ToolCallOutcome): void {
    this.addToolOutput(outcome.call, outcome.output)
    this.emit({
      type: "tool_finished",
      callId: outcome.call.callId,
      tool: outcome.call.name,
      title: outcome.title,
      readOnly: outcome.readOnly,
      output: outcome.output,
      ...(outcome.denial ? { denial: outcome.denial } : {}),
    })
    for (const event of outcome.events) this.publishToolEvent(event)
  }

  private publishToolEvent(event: ToolEvent): void {
    switch (event.type) {
      case "plan_updated":
        this.plan = event.plan
        this.planHandoffActive = event.plan.status === "approved"
        this.emit(event)
        if (event.plan.status === "approved") this.setMode("build")
        break
      case "task_list_updated":
        this.emit(event)
        break
    }
  }
}
