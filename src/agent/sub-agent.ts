import { AgentSession } from "./agent-session"
import type { AgentEvent } from "./events"
import { registerPrompt } from "./prompt"
import { runAgentTurn } from "./run"
import {
  appendAgentTranscript,
  createAgentJob,
  finishAgentJob,
  setAgentActivity,
  startAgentJob,
  stopJob,
  suppressAgentOutcome,
  touchAgentActivity,
  type BackgroundAgentJob,
} from "../background/jobs"
import { backgroundTasksChanged, registerBackgroundTask } from "../background/registry"
import { createManagedWorktree } from "../git/worktrees"
import { describeError } from "../lib/error"
import { asString, isRecord } from "../lib/json"
import { compactPath } from "../lib/path"
import { modeDefinition } from "../permissions/modes"
import { registerPolicyRule } from "../permissions/service"
import { isThinkingEffort, type ThinkingEffort, type Usage } from "../providers/types"
import { toolFailed } from "../tools/output"
import { registerTool } from "../tools/registry"
import type { SessionTool, SessionToolContext } from "../tools/types"

type TaskAccess = "read" | "write"
type TaskIsolation = "shared" | "worktree"

interface TaskItem {
  name?: string
  task: string
  access: TaskAccess
  isolation: TaskIsolation
  thinking?: ThinkingEffort
}

interface ActivityState {
  streamedText: boolean
  activity: string
  toolCalls: Set<string>
  updatedCalls: Set<string>
  usage?: Usage
}

interface Waiter {
  resolve(): void
  reject(error: Error): void
  signal: AbortSignal
  abort(): void
}

class Semaphore {
  private active = 0
  private readonly waiters: Waiter[] = []

  constructor(private readonly limit: number) {}

  acquire(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(new Error("task cancelled before it started"))
    if (this.active < this.limit) {
      this.active += 1
      return Promise.resolve()
    }
    const { promise, resolve, reject } = Promise.withResolvers<void>()
    const waiter: Waiter = {
      resolve,
      reject,
      signal,
      abort: () => {
        const index = this.waiters.indexOf(waiter)
        if (index >= 0) this.waiters.splice(index, 1)
        reject(new Error("task cancelled before it started"))
      },
    }
    signal.addEventListener("abort", waiter.abort, { once: true })
    this.waiters.push(waiter)
    return promise
  }

  release(): void {
    if (this.active > 0) this.active -= 1
    const waiter = this.waiters.shift()
    if (!waiter) return
    waiter.signal.removeEventListener("abort", waiter.abort)
    this.active += 1
    waiter.resolve()
  }
}

const MAX_CONTEXT_LENGTH = 20_000
const MAX_TASK_LENGTH = 20_000
const MAX_BATCH_TASKS = 8
const MAX_CONCURRENT_TASKS = 4
const TASK_TIMEOUT_MS = 10 * 60 * 1_000
const UNAVAILABLE_APPROVAL = "Task-agent actions that require separate approval are unavailable."
const TASK_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/
const scheduler = new Semaphore(MAX_CONCURRENT_TASKS)

function contextFrom(args: Record<string, unknown>): string {
  const context = asString(args.context)?.trim()
  if (!context) throw new Error("context is required")
  if (context.length > MAX_CONTEXT_LENGTH) {
    throw new Error(`context must be at most ${MAX_CONTEXT_LENGTH} characters`)
  }
  return context
}

function accessFrom(value: unknown, index: number): TaskAccess {
  const access = asString(value)
  if (access === "read" || access === "write") return access
  throw new Error(`task ${index + 1} access must be "read" or "write"`)
}

function isolationFrom(value: unknown, index: number): TaskIsolation {
  const isolation = asString(value) ?? "shared"
  if (isolation === "shared" || isolation === "worktree") return isolation
  throw new Error(`task ${index + 1} isolation must be "shared" or "worktree"`)
}

function thinkingFrom(value: unknown, index: number): ThinkingEffort | undefined {
  if (value === undefined) return undefined
  if (isThinkingEffort(value)) return value
  throw new Error(`task ${index + 1} thinking must be one of "none", "low", "medium", "high", "xhigh", or "max"`)
}

function taskFrom(value: unknown, index: number): TaskItem {
  if (!isRecord(value)) throw new Error(`task ${index + 1} must be an object`)
  const task = asString(value.task)?.trim()
  if (!task) throw new Error(`task ${index + 1} is missing task instructions`)
  if (task.length > MAX_TASK_LENGTH) {
    throw new Error(`task ${index + 1} must be at most ${MAX_TASK_LENGTH} characters`)
  }
  const name = asString(value.name)?.trim()
  if (name && !TASK_NAME_PATTERN.test(name)) {
    throw new Error(`task ${index + 1} name must start with a letter and use at most 32 letters, numbers, _ or -`)
  }
  const access = accessFrom(value.access, index)
  const isolation = isolationFrom(value.isolation, index)
  if (isolation === "worktree" && access !== "write") {
    throw new Error(`task ${index + 1} cannot use worktree isolation with read access`)
  }
  return { name, task, access, isolation, thinking: thinkingFrom(value.thinking, index) }
}

function tasksFrom(args: Record<string, unknown>): TaskItem[] {
  if (!Array.isArray(args.tasks) || args.tasks.length === 0) throw new Error("tasks must contain at least one task")
  if (args.tasks.length > MAX_BATCH_TASKS) throw new Error(`tasks may contain at most ${MAX_BATCH_TASKS} tasks`)
  const tasks = args.tasks.map(taskFrom)
  const names = tasks.flatMap((task) => (task.name ? [task.name.toLowerCase()] : []))
  if (new Set(names).size !== names.length) throw new Error("task names must be unique within a batch")
  return tasks
}

function childMode(access: TaskAccess): "plan" | "yolo" {
  return access === "read" ? "plan" : "yolo"
}

function toolActivity(tool: string, title: string): string {
  const detail = title.split("\n", 1)[0]?.trim()
  return detail ? `${tool}: ${detail}` : tool
}

function activity(
  event: AgentEvent,
  child: AgentSession,
  state: ActivityState,
  record: (text: string) => void,
  updateActivity: (value: string) => void,
): void {
  const previousActivity = state.activity
  switch (event.type) {
    case "text_delta":
      state.streamedText = true
      state.activity = "Writing report…"
      record(event.text)
      break
    case "assistant_message":
      if (!state.streamedText) record(`${event.text}\n`)
      state.streamedText = false
      break
    case "tool_started":
      state.toolCalls.add(event.callId)
      state.activity = toolActivity(event.tool, event.title)
      record(`\n> ${state.activity}\n`)
      break
    case "tool_updated":
      state.updatedCalls.add(event.callId)
      record(event.text)
      break
    case "tool_finished": {
      state.toolCalls.add(event.callId)
      const failed = event.denial !== undefined || toolFailed(event.output)
      state.activity = `${failed ? "Failed" : "Finished"} ${toolActivity(event.tool, event.title)}`
      if (!state.updatedCalls.has(event.callId) && event.output) record(`${event.output}\n`)
      record(`${failed ? "x" : "✓"} ${event.tool}\n`)
      break
    }
    case "shell_finished": {
      state.toolCalls.add(event.callId)
      const failed = event.denial !== undefined || toolFailed(event.output)
      state.activity = `${failed ? "Failed" : "Finished"} ${toolActivity("bash", event.command)}`
      if (!state.updatedCalls.has(event.callId) && event.output) record(`${event.output}\n`)
      record(`${failed ? "x" : "✓"} bash\n`)
      break
    }
    case "approval_requested":
      state.activity = `Denied approval for ${event.tool}`
      record(`\n${event.tool} requires unavailable approval and was denied.\n`)
      child.deny("policy", UNAVAILABLE_APPROVAL)
      break
    case "retry_scheduled":
      state.activity = `Retrying in ${Math.ceil(event.delayMs / 1_000)}s`
      record(`\nRetrying in ${Math.ceil(event.delayMs / 1_000)}s: ${event.message}\n`)
      break
    case "turn_failed":
      state.activity = "Failed"
      state.usage = event.usage
      record(`\nTask agent failed: ${event.message}\n`)
      break
    case "turn_interrupted":
      state.activity = "Interrupted"
      record("\nTask agent interrupted.\n")
      break
    case "error":
      state.activity = event.message
      record(`\n${event.message}\n`)
      break
    case "state_changed":
      if (event.state === "streaming") {
        state.activity = "Thinking…"
        backgroundTasksChanged()
      }
      break
    case "hook_finished":
      state.activity = `Hook ${event.hook}: ${event.event} ${event.action}`
      record(`\n> hook: ${event.hook} · ${event.event} · ${event.action} · ${event.elapsedMs}ms\n`)
      backgroundTasksChanged()
      break
    case "turn_ended":
      state.activity = "Report ready"
      state.usage = event.usage
      backgroundTasksChanged()
      break
    case "background_results":
    case "plan_updated":
    case "task_list_updated":
    case "session_started":
    case "session_replay_finished":
    case "session_title_changed":
    case "workspace_changed":
    case "mode_changed":
    case "model_changed":
    case "thinking_changed":
    case "user_message":
    case "conversation_rewound":
    case "conversation_redone":
    case "tool_call_updated":
    case "hook_started":
    case "queue_changed":
    case "queue_flushed":
    case "reasoning_summary_delta":
    case "reasoning_delta":
    case "reasoning_summary":
    case "elicitation_requested":
    case "elicitation_resolved":
    case "compacted":
      break
  }
  if (state.activity !== previousActivity) updateActivity(state.activity)
}

function childPrompt(context: string, task: string): string {
  return `# Context\n${context}\n\n# Assignment\n${task}`
}

function taskToolTitle(args: Record<string, unknown>): string {
  if (!Array.isArray(args.tasks) || args.tasks.length === 0) return "Dispatch tasks"
  const assignments = args.tasks.flatMap((value) => {
    if (!isRecord(value)) return []
    const task = asString(value.task)?.trim().split("\n", 1)[0]
    if (!task) return []
    const name = asString(value.name)?.trim()
    return [`${name ? `${name}: ` : ""}${task.slice(0, 80)}`]
  })
  const preview = assignments.slice(0, 2).join("; ")
  const remaining = assignments.length > 2 ? `; +${assignments.length - 2} more` : ""
  return `Dispatch ${args.tasks.length} ${args.tasks.length === 1 ? "task" : "tasks"}${preview ? ` · ${preview}${remaining}` : ""}`
}

function registerTask(
  job: BackgroundAgentJob,
  item: TaskItem,
  ctx: SessionToolContext,
  state: ActivityState,
  cwd: () => string,
): void {
  registerBackgroundTask({
    kind: "agent",
    id: job.id,
    title: item.task,
    startedAt: job.startedAt,
    role: item.isolation === "worktree" ? "task agent · worktree" : "task agent",
    model: ctx.session.model,
    get cwd() {
      return cwd()
    },
    state: () =>
      job.done ? { running: false, ok: job.outcome?.status === "completed", detail: job.detail } : { running: true },
    output: () => job.transcript,
    snapshot: () => ({
      activity: job.activity,
      elapsedMs: (job.finishedAt ?? Date.now()) - job.startedAt,
      toolCount: state.toolCalls.size,
      usage: state.usage,
    }),
    stop: async () => {
      await stopJob(job)
      suppressAgentOutcome(job)
    },
  })
}

async function runTask(
  job: BackgroundAgentJob,
  item: TaskItem,
  context: string,
  ctx: SessionToolContext,
  controller: AbortController,
  state: ActivityState,
  setChild: (child: AgentSession) => void,
  setCwd: (cwd: string) => void,
): Promise<void> {
  let acquired = false
  let timedOut = false
  let deadline: ReturnType<typeof setTimeout> | undefined
  const record = (text: string): void => appendAgentTranscript(job, text)
  try {
    await scheduler.acquire(controller.signal)
    acquired = true
    if (controller.signal.aborted) throw new Error("task cancelled before it started")
    startAgentJob(job, TASK_TIMEOUT_MS)
    deadline = setTimeout(() => {
      timedOut = true
      controller.abort()
      setAgentActivity(job, "Deadline reached; stopping…")
      record("\nTask reached its 10-minute deadline.\n")
    }, TASK_TIMEOUT_MS)
    deadline.unref()

    const worktree =
      item.isolation === "worktree"
        ? await createManagedWorktree(ctx.session.cwd, item.task, controller.signal)
        : undefined
    if (worktree) {
      setCwd(worktree.cwd)
      record(`Isolated worktree: ${compactPath(worktree.path)}\nBranch: ${worktree.branch}\n\n`)
    }
    if (controller.signal.aborted) throw new Error("task cancelled before it started")

    const child = new AgentSession({
      kind: "subagent",
      cwd: worktree?.cwd ?? ctx.session.cwd,
      provider: ctx.session.provider,
      model: ctx.session.model,
      modelInputModalities: ctx.session.modelInputModalities,
      thinking: item.thinking ?? ctx.session.thinking,
      interactive: false,
      persist: false,
      ...(item.access === "write" && !worktree
        ? { workspaceUndo: ctx.session.workspaceUndo, trackUndoPrompts: false }
        : {}),
    })
    setChild(child)
    child.setMode(childMode(item.access))
    const abortChild = (): void => child.interrupt()
    controller.signal.addEventListener("abort", abortChild)
    let outcome: Awaited<ReturnType<typeof runAgentTurn>>
    try {
      outcome = await runAgentTurn(child, { text: childPrompt(context, item.task), images: [] }, (event) => {
        if (job.done) return
        touchAgentActivity(job)
        activity(event, child, state, record, (value) => setAgentActivity(job, value))
      })
    } finally {
      controller.signal.removeEventListener("abort", abortChild)
    }

    if (timedOut) {
      setAgentActivity(job, "Timed out")
      finishAgentJob(job, { status: "timed_out" }, "timed out after 10m")
      return
    }
    if (outcome.status === "interrupted") {
      setAgentActivity(job, "Interrupted")
      finishAgentJob(job, { status: "interrupted" }, "interrupted")
      return
    }
    if (outcome.status === "failed") {
      setAgentActivity(job, "Failed")
      finishAgentJob(job, { status: "failed" }, `failed: ${outcome.error}`)
      return
    }
    const report =
      typeof outcome.response === "string" ? outcome.response.trim() : JSON.stringify(outcome.response, null, 2)
    if (!report) {
      setAgentActivity(job, "Failed")
      record("\nTask agent completed without a final report.\n")
      finishAgentJob(job, { status: "failed" }, "completed without a final report")
      return
    }
    setAgentActivity(job, "Report ready")
    finishAgentJob(
      job,
      { status: "completed", report },
      worktree ? `completed in ${worktree.branch} at ${compactPath(worktree.path)}` : "completed",
    )
  } catch (error) {
    if (job.done) return
    if (timedOut) {
      setAgentActivity(job, "Timed out")
      finishAgentJob(job, { status: "timed_out" }, "timed out after 10m")
      return
    }
    if (controller.signal.aborted) {
      setAgentActivity(job, "Interrupted")
      finishAgentJob(job, { status: "interrupted" }, "interrupted")
      return
    }
    const message = describeError(error)
    setAgentActivity(job, "Failed")
    record(`\nTask agent failed: ${message}\n`)
    finishAgentJob(job, { status: "failed" }, `failed: ${message}`)
  } finally {
    if (deadline) clearTimeout(deadline)
    if (acquired) scheduler.release()
    ctx.session.deliverAgentResult(job.id)
  }
}

function spawnTask(item: TaskItem, context: string, ctx: SessionToolContext): BackgroundAgentJob {
  const controller = new AbortController()
  let child: AgentSession | undefined
  let cwd = ctx.session.cwd
  const job = createAgentJob("agent", {
    id: item.name,
    ownerId: ctx.session.id,
    task: item.task,
    stop: () => {
      controller.abort()
      child?.interrupt()
    },
    send: (message) => child?.steer(`Parent guidance:\n${message}`) ?? false,
  })
  const state: ActivityState = {
    streamedText: false,
    activity: "Queued…",
    toolCalls: new Set(),
    updatedCalls: new Set(),
  }
  setAgentActivity(job, state.activity)
  registerTask(job, item, ctx, state, () => cwd)
  void runTask(
    job,
    item,
    context,
    ctx,
    controller,
    state,
    (value) => {
      child = value
    },
    (value) => {
      cwd = value
    },
  )
  return job
}

export const taskTool: SessionTool = {
  name: "task",
  description: `Dispatch a batch of independent tasks to background agents. The call returns agent ids immediately, runs up to ${MAX_CONCURRENT_TASKS} agents at once, queues the rest, and automatically delivers each result back into this session. Agents start without conversation history. Read agents cannot modify files; write agents use the shared checkout or an isolated Git worktree.`,
  parameters: {
    type: "object",
    properties: {
      context: {
        type: "string",
        minLength: 1,
        maxLength: MAX_CONTEXT_LENGTH,
        description: "Shared goal, constraints, project state, and contracts that apply to every task in the batch",
      },
      tasks: {
        type: "array",
        minItems: 1,
        maxItems: MAX_BATCH_TASKS,
        items: {
          type: "object",
          properties: {
            name: {
              type: "string",
              pattern: "^[A-Za-z][A-Za-z0-9_-]{0,31}$",
              description: "Optional stable agent id; duplicate live ids receive a numeric suffix",
            },
            task: {
              type: "string",
              minLength: 1,
              maxLength: MAX_TASK_LENGTH,
              description:
                "Complete, self-contained assignment with target, change or investigation, and acceptance criteria",
            },
            access: {
              type: "string",
              enum: ["read", "write"],
              description: "read investigates without edits; write may modify files",
            },
            isolation: {
              type: "string",
              enum: ["shared", "worktree"],
              description: "shared uses the current checkout; worktree gives a write task its own checkout and branch",
            },
            thinking: {
              type: "string",
              enum: ["none", "low", "medium", "high", "xhigh", "max"],
              description: "Reasoning effort for this agent; defaults to the parent's effort",
            },
          },
          required: ["task", "access"],
          additionalProperties: false,
        },
      },
    },
    required: ["context", "tasks"],
    additionalProperties: false,
  },
  prompt:
    "Use task for substantial independent work that can proceed while you continue. Dispatch related work together in one tasks batch and put shared background and cross-task contracts in context. Give every task exact targets, explicit non-goals, and observable acceptance criteria. Give concurrent shared write tasks disjoint files; use worktree isolation when edits may overlap. Isolated changes stay in the reported checkout and branch until you integrate them, then remove the checkout with worktree_remove. Agents start blank, so do not rely on conversation history. Results auto-deliver into your session; do not poll them. Continue useful non-overlapping work or end the current response while they run. Use job_status only to diagnose a stuck task, job_send to correct a running task, and job_kill when it is no longer useful. Run the project's required checks once after all writing agents finish, not inside every task.",
  sessionAware: true,
  available(ctx) {
    return ctx.kind === "primary" && ctx.interactive
  },
  title(args) {
    return taskToolTitle(args)
  },
  readOnly(args) {
    return Array.isArray(args.tasks) && args.tasks.every((item) => isRecord(item) && item.access === "read")
  },
  concurrency() {
    return "shared"
  },
  async execute(args, ctx) {
    if (ctx.session.kind !== "primary") throw new Error("task is available only to primary sessions")
    const context = contextFrom(args)
    const tasks = tasksFrom(args)
    if (modeDefinition(ctx.session.mode).readOnly && tasks.some((task) => task.access === "write")) {
      throw new Error("write tasks are unavailable in a read-only mode")
    }
    const jobs = tasks.map((task) => ({ task, job: spawnTask(task, context, ctx) }))
    const listing = jobs.map(({ task, job }) => `- ${job.id} (${task.access}, ${task.isolation})`).join("\n")
    return {
      output: `Spawned ${jobs.length} background ${jobs.length === 1 ? "agent" : "agents"}. Results will be delivered automatically; no polling is needed.\n${listing}`,
    }
  },
}

export function registerTaskAgents(): void {
  registerPolicyRule({
    evaluate(request) {
      if (request.tool !== taskTool.name || request.readOnly) return undefined
      return "ask"
    },
  })
  registerPrompt({
    id: "task-agent",
    text(prompt) {
      if (prompt.kind !== "subagent") return ""
      return [
        "You are a one-shot task agent working for a primary coding agent. Your first user message contains all shared context and your complete assignment.",
        "Complete only that assignment, work independently with the available tools, and do not ask the user or attempt further delegation.",
        "Return a concise, self-contained final report with the result, evidence, changed files, and verification relevant to the assignment. Report failures clearly.",
      ].join("\n")
    },
  })
  registerTool(taskTool)
}
