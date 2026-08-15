import { release } from "node:os"
import { dirname, resolve } from "node:path"
import { appInfo } from "../../app-info"
import { discardSettledAgentJobs, unsettledJobs } from "../../background/jobs"
import { projectSessionsDir } from "../../config/paths"
import { describeError } from "../../lib/error"
import { runPromptHooks, type HookReporter } from "../../hooks/registry"
import type { HookContext } from "../../hooks/types"
import { defaultPermissionMode } from "../../permissions/modes"
import type { PermissionMode, PermissionScope } from "../../permissions/types"
import type { SessionPlan } from "../../plans/types"
import { profileAgentEvent, profileSessionCreated } from "../../profiler/profiler"
import { promptCacheKey } from "../../providers/cache"
import { prepareConversation } from "../../providers/conversation"
import { occupiedContext } from "../../providers/types"
import type {
  ModelInputModality,
  Provider,
  ProviderPrompt,
  StreamRequest,
  ThinkingEffort,
  ToolCallItem,
  UserInput,
  UserMessageItem,
} from "../../providers/types"
import {
  redactAgentEvent,
  redactHistoryItem,
  redactProviderOutputItem,
  redactSessionStartedEvent,
  redactStreamRequest,
  redactUserInput,
} from "../../secrets/data"
import { redactJsonObject, redactText } from "../../secrets/redactor"
import type { SessionExport } from "../../sessions/export"
import { SessionRecorder } from "../../sessions/recorder"
import { isPersistable } from "../../sessions/records"
import { normalizeSessionTitle, titleFromInput } from "../../sessions/title"
import type { SessionMeta } from "../../sessions/types"
import { expandSkillInvocation } from "../../skills/invoke"
import { getTool, listTools } from "../../tools/registry"
import { toolOutputDirectory } from "../../tools/output"
import { isInteractiveTool } from "../../tools/types"
import { disposeToolSession } from "../../tools/session"
import { WorkspaceUndo } from "../../tools/undo"
import type { ElicitationAnswer, RegisteredTool, ToolEvent } from "../../tools/types"
import type { AgentEvent, AgentState, DenialCause, SessionStartedEvent } from "../events"
import { activeHistory, type ConversationCheckpoint, type HistoryItem } from "../history"
import { isMessageId } from "../message-id"
import { composeSystemPrompt } from "../prompt/registry"
import type { SessionKind } from "../types"
import { backgroundResultsMessage, SessionAsyncState } from "./async"
import { autoCompact, runCompaction, type CompactionHost } from "./compaction"
import { performRedo, performUndo, RedoStack, type HistoryMoveHost } from "./history-moves"
import { PendingInteractions } from "./interactions"
import { OutputContract, parseOutputSchema } from "./output-contract"
import { InputQueue, isDirectShellInput } from "./queue"
import { StreamBuffer, type StreamRoundHost } from "./stream"
import { runDirectShell, runTurn, type TurnHost } from "./turn"
import { ToolCallRunner, type ToolRunnerHost } from "./tool-runner"
import {
  addUsage,
  isAbortError,
  type AgentSessionDeps,
  type AgentSessionState,
  type CompactionOutcome,
  type ForkOutcome,
  type RedoOutcome,
  type ResumeTarget,
  type TurnUsage,
  type UndoCheckpoint,
  type UndoOutcome,
} from "./types"

function recordedContext(events: AgentEvent[]): number | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!
    if (event.type === "compacted" || event.type === "conversation_rewound" || event.type === "conversation_redone") {
      return undefined
    }
    if ((event.type === "turn_ended" || event.type === "turn_failed") && event.context) {
      return occupiedContext(event.context)
    }
  }
  return undefined
}

export class AgentSession {
  private sessionId: string = crypto.randomUUID()
  private parentId: string | undefined
  private sessionPermissionKey = {}
  private title: string | undefined
  private startedAt = Date.now()
  private items: HistoryItem[] = []
  private events: AgentEvent[] = []
  private checkpoints: ConversationCheckpoint[] = []
  private readonly redoStack = new RedoStack()
  private contextTokens: number | undefined
  private compactionFailures = 0
  private readonly turnEndToolEvents = new Map<string, ToolEvent[]>()
  private readonly listeners = new Set<(event: AgentEvent) => void>()
  private readonly recorder: SessionRecorder | undefined
  private readonly interactive: boolean
  private readonly kind: SessionKind
  private readonly outputContract: OutputContract | undefined
  private readonly trackUndoPrompts: boolean
  private readonly inheritedDenyMode: PermissionMode | undefined
  private readonly asyncState: SessionAsyncState
  private readonly toolRunner: ToolCallRunner
  private readonly interactions: PendingInteractions
  private readonly buffer = new StreamBuffer((event) => this.emit(event))
  private readonly queue = new InputQueue((event) => this.emit(event))
  private outputDirectory: string
  private cwd: string
  private workspaceUndo: WorkspaceUndo
  private provider: Provider
  private model: string
  private modelInputModalities: ModelInputModality[] | undefined
  private thinking: ThinkingEffort | undefined
  private state: AgentState = "idle"
  private movingHistory = false
  private mode: PermissionMode = defaultPermissionMode
  private plan: SessionPlan | undefined
  private planHandoffActive = false
  private abortController: AbortController | undefined
  private turnActive = false
  private acceptingQueuedInput = false
  private promoteOnAbort = false
  private readonly hookReporter: HookReporter = {
    started: (hook, event) => {
      this.setState("running_hook")
      this.emit({ type: "hook_started", hook, event })
    },
    finished: (hook, event, action, elapsedMs) => {
      this.emit({ type: "hook_finished", hook, event, action, elapsedMs })
    },
  }

  constructor(deps: AgentSessionDeps) {
    this.kind = deps.kind ?? "primary"
    this.cwd = resolve(deps.cwd ?? process.cwd())
    this.workspaceUndo = deps.workspaceUndo ?? new WorkspaceUndo(this.cwd)
    this.trackUndoPrompts = deps.trackUndoPrompts ?? true
    this.inheritedDenyMode = deps.inheritedDenyMode
    this.provider = deps.provider
    this.model = deps.model
    this.modelInputModalities = deps.modelInputModalities
    this.thinking = deps.thinking
    this.interactive = deps.interactive ?? false
    this.outputContract = deps.outputSchema
      ? new OutputContract(parseOutputSchema(redactJsonObject(deps.outputSchema)))
      : undefined
    this.outputDirectory = toolOutputDirectory(projectSessionsDir(this.cwd), this.sessionId)
    if (deps.persist) {
      this.recorder = new SessionRecorder((message) => this.emit({ type: "error", message }))
      this.recorder.start(this.meta(), this.cwd)
    }
    this.asyncState = new SessionAsyncState({
      ownerId: () => this.sessionId,
      onResultsQueued: () => queueMicrotask(() => this.startBackgroundResultTurn()),
    })
    this.asyncState.register()
    this.interactions = new PendingInteractions({
      interactive: this.interactive,
      cwd: () => this.cwd,
      permissionSessionKey: () => this.sessionPermissionKey,
      emit: (event) => this.emit(event),
      setState: (state) => this.setState(state),
    })
    this.toolRunner = new ToolCallRunner(this.toolRunnerHost())
    profileSessionCreated(this.sessionId, this.kind, this.provider.id, this.model, this.thinking)
  }

  private toolRunnerHost(): ToolRunnerHost {
    return {
      kind: this.kind,
      interactive: this.interactive,
      inheritedDenyMode: this.inheritedDenyMode,
      hookReporter: this.hookReporter,
      sessionId: () => this.sessionId,
      cwd: () => this.cwd,
      mode: () => this.mode,
      outputDirectory: () => this.outputDirectory,
      provider: () => this.provider,
      model: () => this.model,
      modelInputModalities: () => this.modelInputModalities,
      thinking: () => this.thinking,
      workspaceUndo: () => this.workspaceUndo,
      permissionSessionKey: () => this.sessionPermissionKey,
      outputContract: () => this.outputContract,
      availableTool: (name) => this.availableTool(name),
      hookContext: (signal) => this.hookContext(signal),
      emit: (event) => this.emit(event),
      setState: (state) => this.setState(state),
      addToolOutput: (call, output) => this.addToolOutput(call, output),
      updateToolCall: (call) => this.updateToolCall(call),
      publishToolEvent: (event) => this.publishToolEvent(event),
      setTurnEndToolEvents: (tool, events) => this.turnEndToolEvents.set(tool, events),
      requestInput: (callId, request, signal) => this.interactions.requestInput(callId, request, signal),
      requestApproval: (resolve) => this.interactions.awaitApproval(resolve),
      changeWorkspace: (cwd) => this.changeWorkspace(cwd),
    }
  }

  private turnHost(): TurnHost {
    return {
      toolRunner: this.toolRunner,
      hookReporter: this.hookReporter,
      outputContract: () => this.outputContract,
      queuedPromptNext: () => this.queue.promptFirst,
      asyncResultsQueued: () => this.asyncState.hasQueued(),
      emit: (event) => this.emit(event),
      setState: (state) => this.setState(state),
      pushItem: (item) => this.pushItem(item),
      publishToolEvent: (event) => this.publishToolEvent(event),
      hookContext: (signal) => this.hookContext(signal),
      streamRound: (usage) => this.streamHost(usage),
      drainBackgroundResults: () => this.drainBackgroundResults(),
      drainQueue: (signal) => this.drainQueue(signal),
      autoCompact: (signal, provider, model) => autoCompact(this.compactionHost(), signal, provider, model),
      beginCheckpoint: async (messageId, input) => {
        this.ensureTitle(input)
        await this.checkpoint(messageId, input)
      },
      stopAcceptingInput: () => {
        this.acceptingQueuedInput = false
      },
      drainTurnEndEvents: () => this.drainTurnEndEvents(),
    }
  }

  private compactionHost(): CompactionHost {
    return {
      kind: this.kind,
      sessionId: () => this.sessionId,
      history: () => this.items,
      prompt: (model) => this.providerPrompt(model),
      contextTokens: () => this.contextTokens,
      compactionFailures: () => this.compactionFailures,
      recordFailure: () => {
        this.compactionFailures += 1
      },
      replaceHistory: (item) => {
        this.items = []
        this.pushItem(item)
        this.contextTokens = undefined
        this.compactionFailures = 0
      },
      setState: (state) => this.setState(state),
      emit: (event) => this.emit(event),
    }
  }

  private historyMoveHost(): HistoryMoveHost {
    return {
      redoStack: this.redoStack,
      workspaceUndo: () => this.workspaceUndo,
      conversation: () => ({ items: this.items, checkpoints: this.checkpoints }),
      restoreConversation: (state) => {
        this.items = state.items
        this.checkpoints = state.checkpoints
        this.contextTokens = undefined
        this.compactionFailures = 0
      },
      recordEvent: (event) => this.recordEvent(event),
      notify: (event) => this.notifyRedacted(event),
    }
  }

  get id(): string {
    return this.sessionId
  }

  get currentState(): AgentSessionState {
    return this.movingHistory ? "moving_history" : this.state
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

  disposeToolResources(): void {
    disposeToolSession(this.sessionId)
  }

  hasPendingAsyncWork(): boolean {
    return this.asyncState.hasPendingAsyncWork()
  }

  async flushPersistence(): Promise<void> {
    await this.recorder?.flush()
  }

  suppressAsyncDeliveries(): void {
    this.asyncState.suppressAll()
  }

  async cancelAndReapAsyncWork(graceMs?: number): Promise<void> {
    await this.asyncState.cancelAndReap(graceMs)
  }

  disposeAsyncDelivery(): void {
    this.asyncState.dispose()
  }

  startEvent(resumed = false): SessionStartedEvent {
    return redactSessionStartedEvent({
      type: "session_started",
      id: this.sessionId,
      resumed,
      title: this.title,
      provider: this.provider.id,
      model: this.model,
      thinking: this.thinking,
      mode: this.mode,
      cwd: this.cwd,
    })
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
      ...(this.parentId ? { parentId: this.parentId } : {}),
      cwd: redactText(this.cwd),
      provider: redactText(this.provider.id),
      model: redactText(this.model),
      thinking: this.thinking,
      mode: this.mode,
      startedAt: this.startedAt,
    }
  }

  exportSnapshot(): SessionExport {
    return {
      meta: this.meta(),
      ...(this.title ? { title: this.title } : {}),
      events: this.events.map(redactAgentEvent),
    }
  }

  reset(): boolean {
    if (this.currentState !== "idle" || this.asyncState.hasPendingAsyncWork()) return false
    discardSettledAgentJobs(this.sessionId)
    this.disposeToolResources()
    this.asyncState.advanceEpoch()
    this.sessionId = crypto.randomUUID()
    this.parentId = undefined
    this.sessionPermissionKey = {}
    this.title = undefined
    this.outputDirectory = toolOutputDirectory(projectSessionsDir(this.cwd), this.sessionId)
    this.startedAt = Date.now()
    this.items = []
    this.events = []
    this.checkpoints = []
    this.redoStack.reset()
    this.workspaceUndo = new WorkspaceUndo(this.cwd)
    this.contextTokens = undefined
    this.compactionFailures = 0
    this.turnEndToolEvents.clear()
    this.plan = undefined
    this.planHandoffActive = false
    this.buffer.reset()
    this.acceptingQueuedInput = false
    this.asyncState.register()
    this.recorder?.start(this.meta(), this.cwd)
    this.emit(this.startEvent())
    return true
  }

  async fork(): Promise<ForkOutcome> {
    if (this.currentState !== "idle" || this.asyncState.hasPendingAsyncWork()) return { status: "busy" }
    if (this.items.length === 0) return { status: "empty" }
    if (!this.recorder) return { status: "unavailable" }

    this.movingHistory = true
    const parentId = this.sessionId
    const id = crypto.randomUUID()
    const startedAt = Date.now()
    const current = this.meta()
    try {
      const forked = await this.recorder.fork(
        {
          id,
          parentId,
          startedAt,
          cwd: current.cwd,
          provider: current.provider,
          model: current.model,
          thinking: current.thinking,
          mode: current.mode,
        },
        this.cwd,
      )
      discardSettledAgentJobs(parentId)
      this.disposeToolResources()
      this.asyncState.advanceEpoch()
      this.sessionId = id
      this.parentId = parentId
      this.sessionPermissionKey = {}
      this.startedAt = startedAt
      this.events.push(...forked.corrections)
      this.outputDirectory = toolOutputDirectory(dirname(forked.path), id)
      this.turnEndToolEvents.clear()
      this.asyncState.register()
      profileSessionCreated(id, this.kind, this.provider.id, this.model, this.thinking)
      return { status: "forked", id }
    } finally {
      this.movingHistory = false
    }
  }

  resume(target: ResumeTarget): boolean {
    const { meta } = target.session
    if (
      this.currentState !== "idle" ||
      this.asyncState.hasPendingAsyncWork() ||
      (meta.id !== this.sessionId && unsettledJobs(meta.id).length > 0)
    ) {
      return false
    }
    discardSettledAgentJobs(this.sessionId)
    this.disposeToolResources()
    this.asyncState.advanceEpoch()
    this.sessionId = meta.id
    this.parentId = meta.parentId
    this.sessionPermissionKey = {}
    this.title = target.session.title ? redactText(target.session.title) : undefined
    this.outputDirectory = toolOutputDirectory(dirname(target.path), this.sessionId)
    this.cwd = resolve(target.cwd)
    this.startedAt = meta.startedAt
    this.items = target.session.items.map(redactHistoryItem)
    this.events = target.session.events.map(redactAgentEvent)
    this.checkpoints = target.session.checkpoints.map((checkpoint) => ({
      messageId: checkpoint.messageId,
      input: redactUserInput(checkpoint.input),
      before: checkpoint.before.map(redactHistoryItem),
    }))
    this.redoStack.reset()
    this.workspaceUndo = new WorkspaceUndo(this.cwd)
    this.workspaceUndo.seed(
      this.checkpoints.map((checkpoint) => ({ messageId: checkpoint.messageId, prompt: checkpoint.input.text })),
    )
    this.contextTokens = recordedContext(target.session.events)
    this.compactionFailures = 0
    this.turnEndToolEvents.clear()
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
    this.buffer.reset()
    this.acceptingQueuedInput = false
    this.provider = target.provider
    this.model = target.model
    this.modelInputModalities = target.modelInputModalities
    this.thinking = target.thinking
    this.mode = target.mode
    this.asyncState.register()
    this.recorder?.attach(target.path)
    this.emit(this.startEvent(true))
    try {
      for (const event of target.session.events) this.notify(event)
    } finally {
      this.notify({ type: "session_replay_finished" })
    }
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
    if (this.currentState !== "idle") return false
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
    if (this.currentState !== "idle") return false
    if (this.thinking === thinking) return true
    this.thinking = thinking
    this.emit({ type: "thinking_changed", thinking })
    return true
  }

  setMode(mode: PermissionMode): void {
    if (this.movingHistory || this.mode === mode) return
    this.mode = mode
    if (mode === "plan") this.planHandoffActive = false
    this.emit({ type: "mode_changed", mode })
  }

  changeWorkspace(cwd: string): void {
    const next = resolve(cwd)
    if (next === this.cwd) return
    const previous = this.cwd
    this.disposeToolResources()
    this.cwd = next
    this.workspaceUndo = new WorkspaceUndo(next)
    this.workspaceUndo.seed(
      this.checkpoints.map((checkpoint) => ({ messageId: checkpoint.messageId, prompt: checkpoint.input.text })),
    )
    this.redoStack.invalidate("Redo is unavailable because the workspace changed.")
    this.emit({ type: "workspace_changed", cwd: next, previous })
  }

  setTitle(input: string): string | undefined {
    const title = normalizeSessionTitle(redactText(input))
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
    const redacted = redactUserInput(input)
    if (redacted.images.length > 0 && !this.supportsImageInput) {
      this.emit({ type: "error", message: `${this.model} does not support image input` })
      return false
    }
    if (this.movingHistory) return false
    if (this.turnActive) {
      this.queue.push(redacted)
      return true
    }
    if (this.state !== "idle") return false
    if (isDirectShellInput(redacted)) {
      this.startDirectShell(redacted)
      return true
    }
    this.startTurn([redacted])
    return true
  }

  steer(text: string): boolean {
    if (this.movingHistory || !this.turnActive || !this.acceptingQueuedInput) return false
    this.queue.push(redactUserInput({ text, images: [] }))
    return true
  }

  private startTurn(inputs: UserInput[]): void {
    this.startPreparedTurn((signal) => this.acceptInputs(inputs, signal))
  }

  private startBackgroundResultTurn(): boolean {
    if (!this.asyncState.hasQueued() || this.movingHistory || this.turnActive || this.state !== "idle") {
      return false
    }
    this.startPreparedTurn(() => Promise.resolve())
    return true
  }

  private startPreparedTurn(prepare: (signal: AbortSignal) => Promise<void>): void {
    this.outputContract?.reset()
    this.turnEndToolEvents.clear()
    const controller = new AbortController()
    const provider = this.provider
    const model = this.model
    const thinking = this.thinking
    this.abortController = controller
    this.turnActive = true
    this.acceptingQueuedInput = true
    this.promoteOnAbort = false
    this.setState("streaming")
    let errored = false
    const usage: TurnUsage = {}
    void prepare(controller.signal)
      .then(() => runTurn(this.turnHost(), controller.signal, provider, model, thinking, usage))
      .catch((error) => {
        if (isAbortError(error) || controller.signal.aborted) {
          this.emit({ type: "turn_interrupted" })
          return
        }
        errored = true
        this.emit({ type: "turn_failed", message: describeError(error), usage: usage.turn, context: usage.context })
      })
      .finally(() => {
        this.turnEndToolEvents.clear()
        this.turnActive = false
        this.acceptingQueuedInput = false
        this.abortController = undefined
        this.setState("idle")
        if (!errored && controller.signal.aborted && this.promoteOnAbort && this.queue.first !== undefined) {
          this.startNextQueued()
          return
        }
        if (controller.signal.aborted) {
          this.queue.flush()
          this.startBackgroundResultTurn()
          return
        }
        const first = this.queue.first
        if (!errored && first !== undefined && isDirectShellInput(first) && this.startNextQueued()) {
          return
        }
        if (this.startBackgroundResultTurn()) return
        this.queue.flush()
      })
  }

  private startDirectShell(input: UserInput): void {
    this.turnEndToolEvents.clear()
    const controller = new AbortController()
    this.abortController = controller
    this.turnActive = true
    this.acceptingQueuedInput = false
    this.promoteOnAbort = false
    this.setState("running_tool")
    let errored = false
    void runDirectShell(this.turnHost(), input, controller.signal)
      .catch((error) => {
        if (isAbortError(error) || controller.signal.aborted) {
          this.emit({ type: "turn_interrupted" })
          return
        }
        errored = true
        this.emit({ type: "turn_failed", message: describeError(error) })
      })
      .finally(() => {
        this.turnActive = false
        this.acceptingQueuedInput = false
        this.abortController = undefined
        this.setState("idle")
        if (!errored && (!controller.signal.aborted || this.promoteOnAbort) && this.startNextQueued()) return
        if (controller.signal.aborted) {
          this.queue.flush()
          this.startBackgroundResultTurn()
          return
        }
        if (this.startBackgroundResultTurn()) return
        this.queue.flush()
      })
  }

  private startNextQueued(): boolean {
    const shell = this.queue.takeDirectShell()
    if (shell) {
      this.startDirectShell(shell)
      return true
    }
    const inputs = this.queue.takePrompts()
    if (inputs.length === 0) return false
    this.startTurn(inputs)
    return true
  }

  private async drainQueue(signal: AbortSignal): Promise<boolean> {
    const inputs = this.queue.takePrompts()
    if (inputs.length === 0) return false
    await this.acceptInputs(inputs, signal)
    return true
  }

  private drainBackgroundResults(): boolean {
    const results = this.asyncState.drainQueued()
    if (results.length === 0) return false
    this.emit({ type: "background_results", results })
    this.pushItem({ type: "user_message", text: backgroundResultsMessage(results, this.sessionId), images: [] })
    return true
  }

  private async acceptInputs(inputs: UserInput[], signal: AbortSignal): Promise<void> {
    for (const [index, input] of inputs.entries()) {
      try {
        await this.acceptInput(input, signal)
      } catch (error) {
        this.queue.restore(inputs.slice(index + 1))
        throw error
      }
    }
  }

  private async acceptInput(input: UserInput, signal: AbortSignal): Promise<void> {
    this.ensureTitle(input)
    const expanded = redactText((await expandSkillInvocation(input.text)) ?? input.text)
    const outcome = await runPromptHooks(
      { text: expanded, imageCount: input.images.length },
      this.hookContext(signal),
      this.hookReporter,
    )
    if (outcome.type === "blocked") {
      throw new Error(`prompt rejected by hook ${outcome.hook}: ${redactText(outcome.reason)}`)
    }

    const messageId = crypto.randomUUID()
    await this.checkpoint(messageId, input)
    this.emit({
      type: "user_message",
      messageId,
      text: input.text,
      imageCount: input.images.length,
      sentAt: Date.now(),
    })
    this.pushItem(this.userMessage(input, redactText(outcome.text), messageId))
  }

  private async checkpoint(messageId: string, input: UserInput): Promise<void> {
    this.redoStack.invalidate("Redo is unavailable because a new prompt created a divergent branch.")
    if (this.trackUndoPrompts) await this.workspaceUndo.markPromptAfterCaptures(messageId, input.text)
    this.checkpoints.push({ messageId, input: redactUserInput(input), before: [...this.items] })
  }

  private ensureTitle(input: UserInput): void {
    if (this.title) return
    const title = titleFromInput(input.text, input.images.length)
    if (title) this.setTitle(title)
  }

  private userMessage(input: UserInput, modelText: string, messageId: string): UserMessageItem {
    if (modelText === input.text) return { type: "user_message", ...input, messageId }
    return { type: "user_message", ...input, messageId, modelText }
  }

  async undoCheckpoints(): Promise<UndoCheckpoint[]> {
    const previews = new Map((await this.workspaceUndo.previews()).map((preview) => [preview.messageId, preview]))
    return this.checkpoints.map((checkpoint, index) => {
      const preview = previews.get(checkpoint.messageId)
      return {
        messageId: checkpoint.messageId,
        text: checkpoint.input.text,
        imageCount: checkpoint.input.images.length,
        removedMessages: this.checkpoints.length - index,
        paths: preview?.paths ?? [],
        codeAvailable: preview?.codeAvailable ?? false,
        ...(preview?.unavailable === undefined ? {} : { codeUnavailable: preview.unavailable }),
      }
    })
  }

  async undo(messageId: string): Promise<UndoOutcome> {
    if (this.currentState !== "idle" || this.asyncState.hasPendingAgentWork()) return { status: "busy" }
    if (!isMessageId(messageId)) return { status: "invalid" }
    const checkpoint = this.checkpoints.find((candidate) => candidate.messageId === messageId)
    if (!checkpoint) return { status: "invalid" }

    this.movingHistory = true
    try {
      return await performUndo(this.historyMoveHost(), checkpoint)
    } finally {
      this.movingHistory = false
      this.startBackgroundResultTurn()
    }
  }

  async redo(): Promise<RedoOutcome> {
    if (this.currentState !== "idle" || this.asyncState.hasPendingAgentWork()) return { status: "busy" }
    const entry = this.redoStack.peek()
    if (!entry) {
      const invalidated = this.redoStack.message
      return invalidated ? { status: "nothing", message: invalidated } : { status: "nothing" }
    }
    if (entry.branch !== this.workspaceUndo.branch) {
      const message = "Redo is unavailable because a new agent change created a divergent branch."
      this.redoStack.invalidate(message)
      return { status: "nothing", message }
    }

    this.movingHistory = true
    try {
      return await performRedo(this.historyMoveHost(), entry)
    } finally {
      this.movingHistory = false
      this.startBackgroundResultTurn()
    }
  }

  async compact(instructions?: string): Promise<CompactionOutcome> {
    if (this.currentState !== "idle" || this.asyncState.hasPendingAgentWork()) return "busy"
    const controller = new AbortController()
    this.abortController = controller
    this.setState("compacting")
    try {
      const compacted = await runCompaction(
        this.compactionHost(),
        controller.signal,
        this.provider,
        this.model,
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
      this.startBackgroundResultTurn()
    }
  }

  approve(scope: PermissionScope = "once", pattern?: string): void {
    this.interactions.resolveApproval({ decision: "allow", scope, pattern })
  }

  deny(cause: DenialCause = "user", message?: string): void {
    this.interactions.resolveApproval({ decision: "deny", cause, message })
  }

  answerElicitation(requestId: string, answers: ElicitationAnswer[]): boolean {
    return this.interactions.answerElicitation(requestId, answers)
  }

  rejectElicitation(requestId: string): boolean {
    return this.interactions.rejectElicitation(requestId)
  }

  interrupt(queued: "promote" | "flush" = "flush"): void {
    this.promoteOnAbort = queued === "promote"
    this.abortController?.abort()
    this.interactions.resolveApproval({ decision: "deny", cause: "user" })
    this.interactions.resolveElicitation({ status: "rejected" })
  }

  private availableTools(): RegisteredTool[] {
    const tools = listTools().filter((tool) => redactText(tool.name) === tool.name && this.canUseTool(tool))
    const contract = this.outputContract
    const available = contract ? [...tools.filter((tool) => tool.name !== contract.tool.name), contract.tool] : tools
    return available.toSorted((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
  }

  private hookContext(signal: AbortSignal): HookContext {
    return {
      session: {
        id: this.sessionId,
        kind: this.kind,
        cwd: this.cwd,
        provider: this.provider.id,
        model: this.model,
        mode: this.mode,
      },
      signal,
    }
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

  private rememberEvent(event: AgentEvent): void {
    if (isPersistable(event)) this.events.push(event)
  }

  private emit(event: AgentEvent): void {
    const redacted = redactAgentEvent(event)
    profileAgentEvent(this.sessionId, this.kind, redacted)
    this.rememberEvent(redacted)
    this.recorder?.event(redacted)
    this.notifyRedacted(redacted)
    if (event.type === "turn_ended") this.planHandoffActive = false
  }

  private async recordEvent(event: AgentEvent): Promise<AgentEvent> {
    const redacted = redactAgentEvent(event)
    profileAgentEvent(this.sessionId, this.kind, redacted)
    await this.recorder?.eventAndWait(redacted)
    this.rememberEvent(redacted)
    return redacted
  }

  private notify(event: AgentEvent): void {
    this.notifyRedacted(redactAgentEvent(event))
  }

  private notifyRedacted(event: AgentEvent): void {
    for (const listener of this.listeners) listener(event)
  }

  private pushItem(item: HistoryItem): void {
    const redacted = redactHistoryItem(item)
    this.items.push(redacted)
    this.recorder?.item(redacted)
  }

  private setState(state: AgentState): void {
    if (this.state === state) return
    this.state = state
    this.emit({ type: "state_changed", state })
  }

  private addToolOutput(call: ToolCallItem, output: string): void {
    this.pushItem({ type: "tool_result", callId: call.callId, output })
  }

  private drainTurnEndEvents(): ToolEvent[] {
    const events = [...this.turnEndToolEvents.values()].flat()
    this.turnEndToolEvents.clear()
    return events
  }

  private streamHost(usage: TurnUsage): StreamRoundHost {
    return {
      kind: this.kind,
      buffer: this.buffer,
      sessionId: () => this.sessionId,
      emit: (event) => this.emit(event),
      pushItem: (item) => this.pushItem(item),
      buildRequest: (provider, model, thinking, signal) => this.buildStreamRequest(provider, model, thinking, signal),
      redactOutputItem: redactProviderOutputItem,
      onUsage: (turnUsage) => {
        usage.context = turnUsage
        usage.turn = addUsage(usage.turn, turnUsage)
        this.contextTokens = occupiedContext(turnUsage)
      },
    }
  }

  private providerPrompt(model: string): ProviderPrompt {
    const available = this.availableTools()
    const tools = available.map(({ name, description, parameters }) => ({ name, description, parameters }))
    const instructions = composeSystemPrompt({
      appName: appInfo.name,
      platform: `${process.platform} ${release()}`,
      cwd: this.cwd,
      kind: this.kind,
      tools: available,
      mode: this.mode,
      plan: this.mode === "plan" || this.planHandoffActive ? this.plan : undefined,
    })
    return { instructions, tools, cacheKey: promptCacheKey(model, instructions, tools) }
  }

  private buildStreamRequest(
    provider: Provider,
    model: string,
    thinking: ThinkingEffort | undefined,
    signal: AbortSignal,
  ): StreamRequest {
    return redactStreamRequest({
      model,
      thinking,
      ...this.providerPrompt(model),
      input: prepareConversation(activeHistory(this.items), { provider: provider.id, model }),
      toolChoice: "auto",
      sessionId: this.id,
      signal,
    })
  }

  private updateToolCall(call: ToolCallItem): void {
    for (let index = this.items.length - 1; index >= 0; index--) {
      const item = this.items[index]!
      if (item.type !== "tool_call" || item.callId !== call.callId) continue
      this.items[index] = call
      this.emit({ type: "tool_call_updated", callId: call.callId, tool: call.name, args: call.args })
      return
    }
    throw new Error(`cannot update missing tool call: ${call.callId}`)
  }

  private publishToolEvent(event: ToolEvent): void {
    switch (event.type) {
      case "plan_updated":
        this.plan = event.plan
        this.planHandoffActive = event.plan.status === "approved"
        this.emit(event)
        if (event.plan.status === "approved") this.setMode(defaultPermissionMode)
        break
      case "task_list_updated":
        this.emit(event)
        break
    }
  }
}
