import { release } from "node:os"
import { dirname, resolve } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { appInfo } from "../app-info"
import {
  collectAgentOutcome,
  discardSettledAgentJobs,
  getJob,
  runningAgentJobs,
  unsettledAgentJobs,
} from "../background/jobs"
import { projectSessionsDir } from "../config/paths"
import { describeError } from "../lib/error"
import type { JsonObject } from "../lib/json"
import {
  runAfterToolHooks,
  runBeforeToolHooks,
  runPromptHooks,
  runTurnEndHooks,
  type HookReporter,
} from "../hooks/registry"
import type { HookContext } from "../hooks/types"
import { defaultPermissionMode, modeDefinition } from "../permissions/modes"
import { rememberRule } from "../permissions/rules"
import { evaluatePolicy } from "../permissions/service"
import type { PermissionMode, PermissionScope } from "../permissions/types"
import type { SessionPlan } from "../plans/types"
import {
  profileAgentEvent,
  profileProviderFirstEvent,
  profileProviderRequestFinished,
  profileProviderRequestStarted,
  profileSessionCreated,
  profileToolBatchFinished,
  profileToolBatchStarted,
  type ProviderRequestProfile,
} from "../profiler/profiler"
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
import {
  redactAgentEvent,
  redactHistoryItem,
  redactProviderOutputItem,
  redactSessionStartedEvent,
  redactStreamRequest,
  redactUserInput,
} from "../secrets/data"
import { createRedactedStream, redactJsonObject, redactText, type RedactedStream } from "../secrets/redactor"
import { SessionRecorder } from "../sessions/recorder"
import { normalizeSessionTitle, titleFromInput } from "../sessions/title"
import type { LoadedSession, SessionMeta } from "../sessions/types"
import { expandSkillInvocation } from "../skills/invoke"
import { getTool, listTools } from "../tools/registry"
import { boundToolOutput, TOOL_FAILED_PREFIX, TOOL_OUTPUT_UNSAVED_PREFIX, toolOutputDirectory } from "../tools/output"
import { isInteractiveTool, isSessionTool, MAX_ELICITATION_ANSWER_LENGTH } from "../tools/types"
import { WorkspaceUndo, type CodeRedo } from "../tools/undo"
import type {
  ElicitationAnswer,
  ElicitationRequest,
  ElicitationResult,
  RegisteredTool,
  ToolConcurrency,
  ToolEvent,
  ToolResult,
  UndoAction,
} from "../tools/types"
import {
  COMPACTION_TRIGGER_RATIO,
  estimateHistoryTokens,
  resolveCompactionTarget,
  splitForCompaction,
  summarizeHistory,
  tailBudget,
} from "./compaction"
import type { CompactionTrigger } from "./compaction"
import type { AgentEvent, AgentState, BackgroundResult, DenialCause, QueuedEntry, SessionStartedEvent } from "./events"
import {
  activeHistory,
  rewindConversation,
  type ConversationCheckpoint,
  type ConversationState,
  type HistoryItem,
} from "./history"
import { isMessageId } from "./message-id"
import { OutputLoopDetector, ToolLoopDetector, type OutputLoop, type ToolLoopAction } from "./loop-detection"
import { OutputContract, parseOutputSchema, type OutputSchema } from "./output-contract"
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
  workspaceUndo?: WorkspaceUndo
  trackUndoPrompts?: boolean
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

export type AgentSessionState = AgentState | "moving_history"

export interface UndoCheckpoint {
  messageId: string
  text: string
  imageCount: number
  removedMessages: number
  paths: string[]
  codeAvailable: boolean
  codeUnavailable?: string
}

export type UndoOutcome =
  | { status: "undone"; prompt: string; fileCount: number; input: UserInput }
  | { status: "busy" }
  | { status: "invalid" }
  | { status: "stopped"; message: string }

export type RedoOutcome =
  | { status: "redone"; prompt: string; fileCount: number }
  | { status: "busy" }
  | { status: "nothing"; message?: string }
  | { status: "stopped"; message: string }

interface RedoEntry {
  messageId: string
  prompt: string
  conversation: ConversationState
  code: CodeRedo
  fileCount: number
  branch: number
}

const MAX_PROVIDER_ATTEMPTS = 6
const MAX_COMPACTION_FAILURES = 2
const MAX_AGENT_RESULT_CHARS = 12_000

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
  profile: ProviderRequestProfile
  usage?: Usage
}

interface TurnUsage {
  turn?: Usage
  context?: Usage
}

interface ToolCallBatch {
  concurrency: ToolConcurrency
  entries: ToolCallEntry[]
}

type ToolCallEntry = { type: "call"; call: ToolCallItem } | { type: "outcome"; outcome: ToolCallOutcome }

interface PreparedToolCall {
  call: ToolCallItem
  tool: RegisteredTool
  title: string
  readOnly: boolean
  undo: UndoAction
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
  hook: "Blocked by a lifecycle hook.",
}

const subagentPlanDenial =
  "This delegation is read-only, so this action was not run. Continue with read-only tools and report your findings."

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError"
}

function directShellCommand(input: UserInput): string | undefined {
  if (input.images.length > 0) return undefined
  const text = input.text.trimStart()
  return text.startsWith("!") ? text.slice(1).trim() : undefined
}

function isDirectShellInput(input: UserInput): boolean {
  return directShellCommand(input) !== undefined
}

function hasUnsettledAgentJobs(ownerId: string): boolean {
  return unsettledAgentJobs(ownerId).length > 0
}

function boundedAgentResult(output: string): string {
  if (output.length <= MAX_AGENT_RESULT_CHARS) return output
  return `${output.slice(0, MAX_AGENT_RESULT_CHARS)}\n\n[Result truncated; inspect the task transcript for the full output.]`
}

function agentResultsMessage(results: BackgroundResult[], running: number): string {
  const heading =
    results.length === 1
      ? `Background task ${results[0]!.id} has finished. Resume your work using its result.`
      : `${results.length} background tasks have finished. Resume your work using their results.`
  const reports = results.map(
    (result) => `## ${result.id} · ${result.status}\nTask: ${result.task.split("\n", 1)[0]}\n\n${result.output}`,
  )
  return [
    "<system-notice>",
    heading,
    running === 0
      ? "No task agents remain running."
      : `${running} task ${running === 1 ? "agent is" : "agents are"} still running; do not run shared final validation yet.`,
    "Worker reports are evidence, not verification. Check important claims and shared-workspace changes before relying on them.",
    ...reports,
    "</system-notice>",
  ].join("\n\n")
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
  private permissionSessionKey = {}
  private title: string | undefined
  private startedAt = Date.now()
  private items: HistoryItem[] = []
  private checkpoints: ConversationCheckpoint[] = []
  private redos: RedoEntry[] = []
  private redoInvalidated: string | undefined
  private contextTokens: number | undefined
  private compactionFailures = 0
  private readonly pendingAgentResults = new Set<string>()
  private readonly listeners = new Set<(event: AgentEvent) => void>()
  private readonly recorder: SessionRecorder | undefined
  private readonly interactive: boolean
  private readonly kind: SessionKind
  private readonly outputContract: OutputContract | undefined
  private readonly trackUndoPrompts: boolean
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
  private streaming: { kind: StreamKind; text: string; redactor: RedactedStream } | undefined
  private abortController: AbortController | undefined
  private pendingApproval: ((result: ApprovalResult) => void) | undefined
  private pendingElicitation: PendingElicitation | undefined
  private queued: UserInput[] = []
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
    profileSessionCreated(this.sessionId, this.kind, this.provider.id, this.model, this.thinking, this.cwd)
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
      cwd: redactText(this.cwd),
      provider: redactText(this.provider.id),
      model: redactText(this.model),
      thinking: this.thinking,
      mode: this.mode,
      startedAt: this.startedAt,
    }
  }

  reset(): boolean {
    if (this.currentState !== "idle" || hasUnsettledAgentJobs(this.sessionId)) return false
    discardSettledAgentJobs(this.sessionId)
    this.sessionId = crypto.randomUUID()
    this.permissionSessionKey = {}
    this.title = undefined
    this.outputDirectory = toolOutputDirectory(projectSessionsDir(this.cwd), this.sessionId)
    this.startedAt = Date.now()
    this.items = []
    this.checkpoints = []
    this.redos = []
    this.redoInvalidated = undefined
    this.workspaceUndo = new WorkspaceUndo(this.cwd)
    this.contextTokens = undefined
    this.compactionFailures = 0
    this.pendingAgentResults.clear()
    this.plan = undefined
    this.planHandoffActive = false
    this.streaming = undefined
    this.acceptingQueuedInput = false
    this.recorder?.start(this.meta(), this.cwd)
    this.emit(this.startEvent())
    return true
  }

  resume(target: ResumeTarget): boolean {
    if (this.currentState !== "idle" || hasUnsettledAgentJobs(this.sessionId)) return false
    discardSettledAgentJobs(this.sessionId)
    const { meta } = target.session
    this.sessionId = meta.id
    this.permissionSessionKey = {}
    this.title = target.session.title ? redactText(target.session.title) : undefined
    this.outputDirectory = toolOutputDirectory(dirname(target.path), this.sessionId)
    this.cwd = resolve(target.cwd)
    this.startedAt = meta.startedAt
    this.items = target.session.items.map(redactHistoryItem)
    this.checkpoints = target.session.checkpoints.map((checkpoint) => ({
      messageId: checkpoint.messageId,
      input: redactUserInput(checkpoint.input),
      before: checkpoint.before.map(redactHistoryItem),
    }))
    this.redos = []
    this.redoInvalidated = undefined
    this.workspaceUndo = new WorkspaceUndo(this.cwd)
    this.workspaceUndo.seed(
      this.checkpoints.map((checkpoint) => ({ messageId: checkpoint.messageId, prompt: checkpoint.input.text })),
    )
    this.contextTokens = recordedContext(target.session.events)
    this.compactionFailures = 0
    this.pendingAgentResults.clear()
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
    this.acceptingQueuedInput = false
    this.provider = target.provider
    this.model = target.model
    this.modelInputModalities = target.modelInputModalities
    this.thinking = target.thinking
    this.mode = target.mode
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
    this.workspaceUndo = new WorkspaceUndo(next)
    this.workspaceUndo.seed(
      this.checkpoints.map((checkpoint) => ({ messageId: checkpoint.messageId, prompt: checkpoint.input.text })),
    )
    this.invalidateRedos("Redo is unavailable because the workspace changed.")
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
      this.queued.push(redacted)
      this.emit({ type: "queue_changed", entries: this.queueEntries() })
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
    this.queued.push(redactUserInput({ text, images: [] }))
    this.emit({ type: "queue_changed", entries: this.queueEntries() })
    return true
  }

  deliverAgentResult(id: string): void {
    const job = getJob(id)
    if (!job || job.kind !== "agent" || job.ownerId !== this.sessionId || job.consumed) return
    this.pendingAgentResults.add(id)
    queueMicrotask(() => this.startAgentResultTurn())
  }

  private startTurn(inputs: UserInput[]): void {
    this.startPreparedTurn((signal) => this.acceptInputs(inputs, signal))
  }

  private startAgentResultTurn(): boolean {
    if (this.pendingAgentResults.size === 0 || this.movingHistory || this.turnActive || this.state !== "idle") {
      return false
    }
    this.startPreparedTurn(() => Promise.resolve())
    return true
  }

  private startPreparedTurn(prepare: (signal: AbortSignal) => Promise<void>): void {
    this.outputContract?.reset()
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
      .then(() => this.runTurn(controller.signal, provider, model, thinking, usage))
      .catch((error) => {
        if (isAbortError(error) || controller.signal.aborted) {
          this.emit({ type: "turn_interrupted" })
          return
        }
        errored = true
        this.emit({ type: "turn_failed", message: describeError(error), usage: usage.turn, context: usage.context })
      })
      .finally(() => {
        this.turnActive = false
        this.acceptingQueuedInput = false
        this.abortController = undefined
        this.setState("idle")
        if (!errored && controller.signal.aborted && this.promoteOnAbort && this.queued.length > 0) {
          this.startNextQueued()
          return
        }
        if (controller.signal.aborted) {
          this.flushQueue()
          this.startAgentResultTurn()
          return
        }
        if (!errored && this.queued[0] !== undefined && isDirectShellInput(this.queued[0]) && this.startNextQueued()) {
          return
        }
        if (this.startAgentResultTurn()) return
        this.flushQueue()
      })
  }

  private startDirectShell(input: UserInput): void {
    const controller = new AbortController()
    this.abortController = controller
    this.turnActive = true
    this.acceptingQueuedInput = false
    this.promoteOnAbort = false
    this.setState("running_tool")
    let errored = false
    void this.runDirectShell(input, controller.signal)
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
          this.flushQueue()
          this.startAgentResultTurn()
          return
        }
        if (this.startAgentResultTurn()) return
        this.flushQueue()
      })
  }

  private startNextQueued(): boolean {
    const first = this.queued[0]
    if (!first) return false
    if (isDirectShellInput(first)) {
      this.queued.shift()
      this.emit({ type: "queue_changed", entries: this.queueEntries() })
      this.startDirectShell(first)
      return true
    }
    const boundary = this.queued.findIndex(isDirectShellInput)
    const inputs = this.queued.splice(0, boundary < 0 ? this.queued.length : boundary)
    this.emit({ type: "queue_changed", entries: this.queueEntries() })
    this.startTurn(inputs)
    return true
  }

  private queueEntries(): QueuedEntry[] {
    return this.queued.map((input) => ({ text: input.text, imageCount: input.images.length }))
  }

  private async drainQueue(signal: AbortSignal): Promise<boolean> {
    if (this.queued.length === 0) return false
    const boundary = this.queued.findIndex(isDirectShellInput)
    if (boundary === 0) return false
    const inputs = this.queued.splice(0, boundary < 0 ? this.queued.length : boundary)
    this.emit({ type: "queue_changed", entries: this.queueEntries() })
    await this.acceptInputs(inputs, signal)
    return true
  }

  private drainAgentResults(): boolean {
    if (this.pendingAgentResults.size === 0) return false
    const results: BackgroundResult[] = []
    const pending = [...this.pendingAgentResults]
    this.pendingAgentResults.clear()
    for (const id of pending) {
      const job = getJob(id)
      if (!job || job.kind !== "agent" || job.ownerId !== this.sessionId || job.consumed) continue
      if (!job.done || !job.outcome) {
        this.pendingAgentResults.add(id)
        continue
      }
      const outcome = collectAgentOutcome(job)
      if (outcome.status === "already_collected") continue
      const output =
        outcome.status === "completed" && job.detail !== "completed"
          ? `${outcome.report}\n\nWorkspace: ${job.detail}`
          : outcome.status === "completed"
            ? outcome.report
            : job.detail
      results.push({
        id: job.id,
        task: job.task,
        status: outcome.status,
        output: boundedAgentResult(output),
      })
    }
    if (results.length === 0) return false
    this.emit({ type: "background_results", results })
    const running = runningAgentJobs(this.sessionId).length
    this.pushItem({ type: "user_message", text: agentResultsMessage(results, running), images: [] })
    return true
  }

  private async acceptInputs(inputs: UserInput[], signal: AbortSignal): Promise<void> {
    for (const [index, input] of inputs.entries()) {
      try {
        await this.acceptInput(input, signal)
      } catch (error) {
        const remaining = inputs.slice(index + 1)
        if (remaining.length > 0) {
          this.queued.unshift(...remaining)
          this.emit({ type: "queue_changed", entries: this.queueEntries() })
        }
        throw error
      }
    }
  }

  private async acceptInput(input: UserInput, signal: AbortSignal): Promise<void> {
    this.ensureTitle(input)
    const expanded = redactText(expandSkillInvocation(input.text) ?? input.text)
    const outcome = await runPromptHooks(
      { text: expanded, imageCount: input.images.length },
      this.hookContext(signal),
      this.hookReporter,
    )
    if (outcome.type === "blocked") {
      throw new Error(`prompt rejected by hook ${outcome.hook}: ${redactText(outcome.reason)}`)
    }

    const messageId = crypto.randomUUID()
    this.invalidateRedos("Redo is unavailable because a new prompt created a divergent branch.")
    if (this.trackUndoPrompts) await this.workspaceUndo.markPromptAfterCaptures(messageId, input.text)
    this.checkpoints.push({ messageId, input: redactUserInput(input), before: [...this.items] })
    this.emit({
      type: "user_message",
      messageId,
      text: input.text,
      imageCount: input.images.length,
      sentAt: Date.now(),
    })
    this.pushItem(this.userMessage(input, redactText(outcome.text), messageId))
  }

  private async runDirectShell(input: UserInput, signal: AbortSignal): Promise<void> {
    const command = directShellCommand(input)
    if (command === undefined) throw new Error("direct shell received a regular prompt")
    const messageId = crypto.randomUUID()
    const requestedCall: ToolCallItem = {
      type: "tool_call",
      callId: `direct-shell-${crypto.randomUUID()}`,
      name: "bash",
      args: { command },
    }

    let outcome: ToolCallOutcome | undefined
    let prepared: PreparedToolCall | undefined
    if (!command) {
      outcome = this.toolCallOutcome(requestedCall, "", false, `${TOOL_FAILED_PREFIX}shell command is empty`)
    } else {
      const entry = await this.applyBeforeToolHook(requestedCall, signal, false)
      if (entry.type === "outcome") {
        outcome = entry.outcome
      } else {
        const preparation = await this.prepareToolCall(entry.call, signal)
        if (preparation.type === "outcome") outcome = preparation.outcome
        else prepared = preparation.prepared
      }
    }

    this.ensureTitle(input)
    this.invalidateRedos("Redo is unavailable because a new prompt created a divergent branch.")
    if (this.trackUndoPrompts) await this.workspaceUndo.markPromptAfterCaptures(messageId, input.text)
    this.checkpoints.push({ messageId, input, before: [...this.items] })
    if (prepared) outcome = await this.executeToolCall(prepared, signal)
    if (!outcome) throw new Error("direct shell did not produce an outcome")

    const executed = outcome.call.args.command
    const executedCommand = typeof executed === "string" ? executed.trim() : command

    const finished: Extract<AgentEvent, { type: "shell_finished" }> = {
      type: "shell_finished",
      messageId,
      callId: outcome.call.callId,
      input: input.text,
      command: executedCommand,
      output: outcome.output,
      readOnly: outcome.readOnly,
      ...(outcome.denial ? { denial: outcome.denial } : {}),
    }
    this.emit(finished)
    this.pushItem({
      type: "direct_shell",
      messageId: finished.messageId,
      callId: finished.callId,
      input: finished.input,
      command: finished.command,
      output: finished.output,
      readOnly: finished.readOnly,
      ...(finished.denial ? { denial: finished.denial } : {}),
    })
    for (const event of outcome.events) this.publishToolEvent(event)

    if (signal.aborted) {
      this.emit({ type: "turn_interrupted" })
      return
    }
    await this.endTurn({}, outcome.output, signal)
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

  private flushQueue(): void {
    if (this.queued.length === 0) return
    const inputs = this.queued.splice(0)
    this.emit({ type: "queue_changed", entries: [] })
    this.emit({ type: "queue_flushed", inputs })
  }

  private invalidateRedos(reason: string): void {
    if (this.redos.length === 0) return
    this.redos = []
    this.redoInvalidated = reason
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
    if (this.currentState !== "idle" || hasUnsettledAgentJobs(this.sessionId)) return { status: "busy" }
    if (!isMessageId(messageId)) return { status: "invalid" }
    const checkpoint = this.checkpoints.find((candidate) => candidate.messageId === messageId)
    if (!checkpoint) return { status: "invalid" }

    this.movingHistory = true
    try {
      return await this.performUndo(checkpoint)
    } finally {
      this.movingHistory = false
    }
  }

  private async performUndo(checkpoint: ConversationCheckpoint): Promise<UndoOutcome> {
    let codeRewind: import("../tools/undo").CodeRewind
    try {
      codeRewind = await this.workspaceUndo.rewind(checkpoint.messageId)
    } catch (error) {
      return { status: "stopped", message: describeError(error) }
    }

    const rewound = rewindConversation({ items: this.items, checkpoints: this.checkpoints }, checkpoint.messageId)
    if (!rewound) {
      try {
        await codeRewind.rollback()
      } catch (error) {
        return {
          status: "stopped",
          message: `the checkpoint changed and code rollback failed: ${describeError(error)}`,
        }
      }
      return { status: "invalid" }
    }
    if (codeRewind.steps !== rewound.redos.length) {
      try {
        await codeRewind.rollback()
      } catch (error) {
        return {
          status: "stopped",
          message: `conversation and code history disagree; code rollback also failed: ${describeError(error)}`,
        }
      }
      return { status: "stopped", message: "conversation and code history disagree" }
    }

    const fileCount = codeRewind.count
    let recorded: AgentEvent
    try {
      recorded = await this.recordEvent({
        type: "conversation_rewound",
        messageId: checkpoint.messageId,
        prompt: checkpoint.input.text,
        removedMessages: rewound.removedMessages,
        fileCount,
      })
    } catch (error) {
      try {
        await codeRewind.rollback()
      } catch (rollbackError) {
        return {
          status: "stopped",
          message: `the conversation could not be saved: ${describeError(error)}; code rollback also failed: ${describeError(rollbackError)}`,
        }
      }
      return { status: "stopped", message: `the conversation could not be saved: ${describeError(error)}` }
    }

    const codeRedos = codeRewind.commit()
    this.items = rewound.active.items
    this.checkpoints = rewound.active.checkpoints
    this.contextTokens = undefined
    this.compactionFailures = 0
    this.redoInvalidated = undefined
    const branch = this.workspaceUndo.branch
    this.redos.push(
      ...rewound.redos
        .map((conversation, index): RedoEntry => {
          const code = codeRedos[index]
          if (!code) throw new Error("conversation and code redo history disagree")
          return {
            messageId: conversation.messageId,
            prompt: conversation.prompt,
            conversation: conversation.state,
            code,
            fileCount: code.count,
            branch,
          }
        })
        .toReversed(),
    )
    this.notifyRedacted(recorded)
    return {
      status: "undone",
      prompt: checkpoint.input.text,
      fileCount,
      input: rewound.input,
    }
  }

  async redo(): Promise<RedoOutcome> {
    if (this.currentState !== "idle" || hasUnsettledAgentJobs(this.sessionId)) return { status: "busy" }
    const entry = this.redos.at(-1)
    if (!entry) {
      return this.redoInvalidated ? { status: "nothing", message: this.redoInvalidated } : { status: "nothing" }
    }
    if (entry.branch !== this.workspaceUndo.branch) {
      this.redos = []
      this.redoInvalidated = "Redo is unavailable because a new agent change created a divergent branch."
      return { status: "nothing", message: this.redoInvalidated }
    }

    this.movingHistory = true
    try {
      return await this.performRedo(entry)
    } finally {
      this.movingHistory = false
    }
  }

  private async performRedo(entry: RedoEntry): Promise<RedoOutcome> {
    let applied: import("../tools/undo").AppliedCodeRedo
    try {
      applied = await entry.code.apply()
    } catch (error) {
      return { status: "stopped", message: describeError(error) }
    }

    const restoredMessages = entry.conversation.checkpoints.length - this.checkpoints.length
    if (restoredMessages < 1) {
      try {
        await applied.rollback()
      } catch (error) {
        return {
          status: "stopped",
          message: `the superseded conversation is unavailable; code rollback also failed: ${describeError(error)}`,
        }
      }
      return { status: "stopped", message: "the superseded conversation is unavailable" }
    }

    let recorded: AgentEvent
    try {
      recorded = await this.recordEvent({
        type: "conversation_redone",
        messageId: entry.messageId,
        prompt: entry.prompt,
        restoredMessages,
        fileCount: entry.fileCount,
      })
    } catch (error) {
      try {
        await applied.rollback()
      } catch (rollbackError) {
        return {
          status: "stopped",
          message: `the conversation could not be saved: ${describeError(error)}; code rollback also failed: ${describeError(rollbackError)}`,
        }
      }
      return { status: "stopped", message: `the conversation could not be saved: ${describeError(error)}` }
    }

    this.items = entry.conversation.items
    this.checkpoints = entry.conversation.checkpoints
    this.contextTokens = undefined
    this.compactionFailures = 0
    applied.commit()
    this.redos.pop()
    this.redoInvalidated = undefined
    this.notifyRedacted(recorded)
    return {
      status: "redone",
      prompt: entry.prompt,
      fileCount: entry.fileCount,
    }
  }

  async compact(instructions?: string): Promise<CompactionOutcome> {
    if (this.currentState !== "idle" || hasUnsettledAgentJobs(this.sessionId)) return "busy"
    const controller = new AbortController()
    this.abortController = controller
    this.setState("compacting")
    try {
      const compacted = await this.runCompaction(controller.signal, this.provider, this.model, "manual", instructions)
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
      rememberRule(this.permissionSessionKey, this.cwd, result.pattern, result.scope).catch((error) => {
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
    const tools = listTools().filter((tool) => redactText(tool.name) === tool.name && this.canUseTool(tool))
    const contract = this.outputContract
    if (!contract) return tools
    return [...tools.filter((tool) => tool.name !== contract.tool.name), contract.tool]
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

  private emit(event: AgentEvent): void {
    const redacted = redactAgentEvent(event)
    profileAgentEvent(this.sessionId, this.kind, redacted)
    this.recorder?.event(redacted)
    this.notifyRedacted(redacted)
    if (event.type === "turn_ended") this.planHandoffActive = false
  }

  private async recordEvent(event: AgentEvent): Promise<AgentEvent> {
    const redacted = redactAgentEvent(event)
    profileAgentEvent(this.sessionId, this.kind, redacted)
    await this.recorder?.eventAndWait(redacted)
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

  private stream(kind: StreamKind, text: string): void {
    if (this.streaming && this.streaming.kind !== kind) this.flushStream()
    const streaming = this.streaming ?? { kind, text: "", redactor: createRedactedStream() }
    const redacted = streaming.redactor.write(text)
    streaming.text += redacted
    this.streaming = streaming
    if (!redacted) return
    this.emit(
      kind === "assistant"
        ? { type: "text_delta", text: redacted }
        : { type: "reasoning_summary_delta", text: redacted },
    )
  }

  private flushStream(): void {
    const streaming = this.streaming
    this.streaming = undefined
    if (!streaming) return
    const tail = streaming.redactor.end()
    if (tail) {
      streaming.text += tail
      this.emit(
        streaming.kind === "assistant"
          ? { type: "text_delta", text: tail }
          : { type: "reasoning_summary_delta", text: tail },
      )
    }
    if (!streaming.text) return
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
    trigger: CompactionTrigger,
    instructions?: string,
  ): Promise<boolean> {
    const budget = tailBudget(await contextWindow(provider, model), trigger)
    const { head, tail, replaced } = splitForCompaction(this.items, budget)
    if (head.length === 0) return false

    this.setState("compacting")
    const target = await resolveCompactionTarget(provider, model)
    const summary = await summarizeHistory({
      provider,
      model: target.model,
      historyModel: model,
      thinking: target.thinking,
      sessionId: this.sessionId,
      kind: this.kind,
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

  private async autoCompact(signal: AbortSignal, provider: Provider, model: string): Promise<void> {
    if (this.compactionFailures >= MAX_COMPACTION_FAILURES) return
    const tokens = this.contextTokens ?? estimateHistoryTokens(activeHistory(this.items))
    const window = await contextWindow(provider, model)
    if (window === undefined || tokens < window * COMPACTION_TRIGGER_RATIO) return

    try {
      await this.runCompaction(signal, provider, model, "auto")
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
    usage: TurnUsage,
  ): Promise<void> {
    const toolLoops = new ToolLoopDetector()

    while (true) {
      if (this.drainAgentResults()) toolLoops.reset()
      await this.autoCompact(signal, provider, model)
      if (signal.aborted) {
        this.emit({ type: "turn_interrupted" })
        return
      }
      if (await this.drainQueue(signal)) toolLoops.reset()

      this.setState("streaming")
      const items = await this.streamRound(signal, provider, model, thinking, usage)
      if (!items) return

      this.flushStream()
      for (const item of items) this.pushItem(item)

      const toolCalls = items.filter((item): item is ToolCallItem => item.type === "tool_call")
      if (toolCalls.length === 0) {
        if (this.queued.length > 0 && !isDirectShellInput(this.queued[0]!)) continue
        if (this.pendingAgentResults.size > 0) continue
        if (this.outputContract) {
          const correction = this.outputContract.missing()
          if (this.outputContract.exhausted) throw this.outputContract.failure()
          this.pushItem({ type: "user_message", text: correction, images: [] })
          continue
        }
        const final = items.findLast((item) => item.type === "assistant_message")
        await this.endTurn(usage, final?.type === "assistant_message" ? final.text : undefined, signal)
        return
      }

      let loopError: Error | undefined
      let sharedEntries: ToolCallEntry[] = []
      for (const [index, call] of toolCalls.entries()) {
        const entry = await this.applyBeforeToolHook(call, signal)
        if (this.toolCallConcurrency(entry) === "shared") {
          sharedEntries.push(entry)
          continue
        }

        if (sharedEntries.length > 0) {
          loopError = await this.runToolCallBatch({ concurrency: "shared", entries: sharedEntries }, signal, toolLoops)
          sharedEntries = []
          const stopReason = this.toolCallStopReason(loopError, signal)
          if (stopReason) {
            this.finishSkippedToolEntry(entry, stopReason)
            for (const remaining of toolCalls.slice(index + 1)) this.finishSkippedToolCall(remaining, stopReason)
            break
          }
        }

        loopError = await this.runToolCallBatch({ concurrency: "exclusive", entries: [entry] }, signal, toolLoops)
        const stopReason = this.toolCallStopReason(loopError, signal)
        if (!stopReason) continue
        for (const remaining of toolCalls.slice(index + 1)) this.finishSkippedToolCall(remaining, stopReason)
        break
      }
      if (sharedEntries.length > 0) {
        loopError = await this.runToolCallBatch({ concurrency: "shared", entries: sharedEntries }, signal, toolLoops)
      }
      if (loopError) throw loopError
      if (this.outputContract?.output) {
        if ((this.queued.length > 0 && !isDirectShellInput(this.queued[0]!)) || this.pendingAgentResults.size > 0) {
          this.outputContract.reset()
          continue
        }
        await this.endTurn(usage, this.outputContract.output, signal)
        return
      }
      if (this.outputContract?.exhausted) throw this.outputContract.failure()

      if (signal.aborted) {
        this.emit({ type: "turn_interrupted" })
        return
      }
    }
  }

  private async endTurn(usage: TurnUsage, output: string | JsonObject | undefined, signal: AbortSignal): Promise<void> {
    this.acceptingQueuedInput = false
    await runTurnEndHooks(
      {
        ...(output === undefined ? {} : { output }),
        ...(usage.turn ? { usage: usage.turn } : {}),
        ...(usage.context ? { context: usage.context } : {}),
      },
      this.hookContext(signal),
      this.hookReporter,
    )
    this.emit({
      type: "turn_ended",
      usage: usage.turn,
      context: usage.context,
      ...(typeof output === "string" || output === undefined ? {} : { output }),
    })
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
      const profile = profileProviderRequestStarted(
        this.sessionId,
        this.kind,
        "turn",
        provider.id,
        model,
        thinking,
        attempt,
      )
      const round: StreamRound = { received: false, items: [], profile }
      try {
        await this.consumeStream(signal, provider, model, thinking, round, usage)
        profileProviderRequestFinished(profile, "completed", round.usage)
        return round.items
      } catch (error) {
        profileProviderRequestFinished(
          profile,
          isAbortError(error) || signal.aborted ? "interrupted" : "failed",
          round.usage,
          describeError(error),
        )
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

    const rawReasoning = createRedactedStream()
    for await (const event of provider.stream(
      redactStreamRequest({
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
      }),
    )) {
      if (!round.received) profileProviderFirstEvent(round.profile, event.type)
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
          {
            const text = rawReasoning.write(event.text)
            if (text) this.emit({ type: "reasoning_delta", text })
          }
          break
        case "item_done": {
          const item = redactProviderOutputItem(event.item)
          if (event.item.type === "assistant_message") {
            if (!assistantStreamed) {
              detectLoop(outputLoops.assistant, event.item.text, "assistant response")
              if (item.type === "assistant_message" && item.text) {
                this.emit({ type: "assistant_message", text: item.text })
              }
            }
            finishLoop(outputLoops.assistant, "assistant response")
            assistantStreamed = false
          }
          if (event.item.type === "reasoning") {
            if (!reasoningStreamed) {
              detectLoop(outputLoops.reasoning, event.item.summary, "reasoning summary")
              if (item.type === "reasoning" && item.summary) {
                this.emit({ type: "reasoning_summary", text: item.summary })
              }
            }
            finishLoop(outputLoops.reasoning, "reasoning summary")
            reasoningStreamed = false
          }
          round.items.push(item)
          break
        }
        case "done": {
          finishLoop(outputLoops.assistant, "assistant response")
          finishLoop(outputLoops.reasoning, "reasoning summary")
          finishLoop(outputLoops.rawReasoning, "reasoning")
          round.usage = event.usage
          if (!round.usage) break
          usage.context = round.usage
          usage.turn = addUsage(usage.turn, round.usage)
          this.contextTokens = occupiedContext(round.usage)
          break
        }
      }
    }
    const rawReasoningTail = rawReasoning.end()
    if (rawReasoningTail) this.emit({ type: "reasoning_delta", text: rawReasoningTail })
  }

  private async applyBeforeToolHook(
    original: ToolCallItem,
    signal: AbortSignal,
    recordUpdate = true,
  ): Promise<ToolCallEntry> {
    const outcome = await runBeforeToolHooks(
      { callId: original.callId, tool: original.name, args: original.args },
      this.hookContext(signal),
      this.hookReporter,
    )
    const args = redactJsonObject(outcome.args)
    const call: ToolCallItem = outcome.modified
      ? { type: "tool_call", callId: original.callId, name: original.name, args }
      : original
    if (outcome.modified && recordUpdate) this.updateToolCall(call)
    if (outcome.type === "continue") return { type: "call", call }
    return {
      type: "outcome",
      outcome: this.skippedToolCallOutcome(
        call,
        `Blocked by hook ${outcome.hook}: ${redactText(outcome.reason)}`,
        "hook",
      ),
    }
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

  private toolCallConcurrency(entry: ToolCallEntry): ToolConcurrency {
    if (entry.type === "outcome") return "exclusive"
    const tool = this.availableTool(entry.call.name)
    return tool?.concurrency?.(entry.call.args, { cwd: this.cwd }) ?? "exclusive"
  }

  private toolCallStopReason(loopError: Error | undefined, signal: AbortSignal): string | undefined {
    if (loopError) return "Not run because a repeated tool loop stopped the turn."
    if (this.outputContract?.output || this.outputContract?.exhausted) {
      return "Not run because structured output ended the turn."
    }
    if (signal.aborted) return "Interrupted by user before execution."
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

  private skippedToolCallOutcome(call: ToolCallItem, output: string, denial?: DenialCause): ToolCallOutcome {
    const tool = this.availableTool(call.name)
    const title = tool?.title(call.args, { cwd: this.cwd }) ?? JSON.stringify(call.args)
    const readOnly = tool?.readOnly?.(call.args, { cwd: this.cwd }) ?? false
    return this.toolCallOutcome(call, title, readOnly, output, denial)
  }

  private finishSkippedToolCall(call: ToolCallItem, output: string): void {
    this.commitToolCall(this.skippedToolCallOutcome(call, output))
  }

  private finishSkippedToolEntry(entry: ToolCallEntry, output: string): void {
    if (entry.type === "outcome") {
      this.commitToolCall(entry.outcome)
      return
    }
    this.finishSkippedToolCall(entry.call, output)
  }

  private async runToolCallBatch(
    batch: ToolCallBatch,
    signal: AbortSignal,
    toolLoops: ToolLoopDetector,
  ): Promise<Error | undefined> {
    const profile = profileToolBatchStarted(
      this.sessionId,
      this.kind,
      batch.concurrency,
      batch.entries.map((entry) => (entry.type === "call" ? entry.call.name : entry.outcome.call.name)),
    )
    try {
      const outcomes: Array<ToolCallOutcome | undefined> = batch.entries.map(() => undefined)
      const ready: Array<{ index: number; prepared: PreparedToolCall }> = []
      const recorded = batch.entries.map(() => false)
      let loopError: Error | undefined

      for (const [index, entry] of batch.entries.entries()) {
        const call = entry.type === "call" ? entry.call : entry.outcome.call
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
        if (entry.type === "outcome") {
          outcomes[index] = entry.outcome
          continue
        }
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
      profileToolBatchFinished(
        profile,
        loopError ? "failed" : signal.aborted ? "interrupted" : "completed",
        loopError?.message,
      )
      return loopError
    } catch (error) {
      profileToolBatchFinished(
        profile,
        isAbortError(error) || signal.aborted ? "interrupted" : "failed",
        describeError(error),
      )
      throw error
    }
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
      sessionKey: this.permissionSessionKey,
      cwd: this.cwd,
      tool: call.name,
      title,
      args: call.args,
      subject: permission?.subject,
      readOnly,
      sandboxed,
      mode: this.mode,
    })

    if (decision === "deny") {
      const cause = modeDefinition(this.mode).readOnly && !readOnly ? "plan" : "policy"
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

    const undo: UndoAction = tool.undo?.(call.args, { cwd: this.cwd }) ?? { type: "none" }
    return { type: "ready", prepared: { call, tool, title, readOnly, undo } }
  }

  private async executeToolCall(prepared: PreparedToolCall, signal: AbortSignal): Promise<ToolCallOutcome> {
    const { call, tool, title, readOnly, undo } = prepared
    if (signal.aborted) {
      return this.toolCallOutcome(call, title, readOnly, "Interrupted by user before execution.")
    }

    this.setState("running_tool")
    this.emit({ type: "tool_started", callId: call.callId, tool: call.name, title, readOnly })
    let output: string
    let events: ToolEvent[] = []
    let maxOutputBytes: number | undefined
    const updates = createRedactedStream()
    const update = (text: string): void => {
      const redacted = updates.write(text)
      if (redacted) this.emit({ type: "tool_updated", callId: call.callId, text: redacted })
    }
    try {
      const execute = (): Promise<ToolResult> =>
        isInteractiveTool(tool)
          ? tool.execute(call.args, {
              session: { directory: this.outputDirectory, mode: this.mode },
              publish: (event) => this.publishToolEvent(event),
              requestInput: (request) => this.requestInput(call.callId, request, signal),
            })
          : isSessionTool(tool)
            ? tool.execute(call.args, {
                session: {
                  id: this.sessionId,
                  kind: this.kind,
                  cwd: this.cwd,
                  provider: this.provider,
                  model: this.model,
                  modelInputModalities: this.modelInputModalities,
                  thinking: this.thinking,
                  mode: this.mode,
                  workspaceUndo: this.workspaceUndo,
                  changeWorkspace: (cwd) => this.changeWorkspace(cwd),
                  deliverAgentResult: (id) => this.deliverAgentResult(id),
                },
                signal,
                update,
              })
            : tool.execute(call.args, { cwd: this.cwd, signal, update })
      let result: ToolResult
      switch (undo.type) {
        case "none":
          result = await execute()
          break
        case "paths":
          result = await this.workspaceUndo.trackPaths(call.name, undo.paths, execute)
          break
        case "workspace":
          result = await this.workspaceUndo.trackWorkspace(call.name, execute)
          break
        case "invalidate":
          result = await this.workspaceUndo.trackInvalidation(execute)
          break
      }
      output = redactText(result.output)
      events = result.events ?? []
      maxOutputBytes = result.maxOutputBytes
    } catch (error) {
      output = redactText(`${TOOL_FAILED_PREFIX}${describeError(error)}`)
    } finally {
      const tail = updates.end()
      if (tail) this.emit({ type: "tool_updated", callId: call.callId, text: tail })
    }
    try {
      output = redactText(
        await runAfterToolHooks(
          { callId: call.callId, tool: call.name, args: call.args, title, readOnly, output },
          this.hookContext(signal),
          this.hookReporter,
        ),
      )
    } catch (error) {
      if (!isAbortError(error)) {
        output = redactText(
          `${TOOL_FAILED_PREFIX}${describeError(error)}. The tool may have changed state; inspect it before retrying.`,
        )
      }
    }
    output = redactText(output)
    try {
      output = await boundToolOutput(this.outputDirectory, output, maxOutputBytes)
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
        if (event.plan.status === "approved") this.setMode(defaultPermissionMode)
        break
      case "task_list_updated":
        this.emit(event)
        break
    }
  }
}
