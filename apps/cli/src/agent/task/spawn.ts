import {
  appendAgentTranscript,
  attachJobLog,
  createAgentJob,
  sendAgentGuidance,
  setAgentActivity,
  startAgentJob,
  stopJob,
  touchAgentActivity,
  type BackgroundAgentJob,
} from "../../background/jobs"
import { createJobLog } from "../../background/log"
import { registerBackgroundTask } from "../../background/registry"
import { settings } from "../../config/settings"
import { resolveThinking } from "../../config/thinking"
import { createManagedWorktree, type ManagedWorktree } from "../../git/worktrees"
import { describeError } from "../../lib/error"
import { compactPath } from "../../lib/path"
import type { PermissionMode } from "../../permissions/types"
import type { SessionToolContext } from "../../tools/types"
import { AgentSession } from "../session/session"
import { activity, type ActivityState } from "./activity"
import { driveTaskToQuiescence, type TaskDriveOutcome } from "./drive"
import type { TaskAccess, TaskItem } from "./parse"
import { finishTask, taskOutput, type TaskTerminal } from "./record"

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

let scheduler: Semaphore | undefined

function taskScheduler(): Semaphore {
  scheduler ??= new Semaphore(settings().agents.maxConcurrent)
  return scheduler
}

function childMode(access: TaskAccess, parentMode: PermissionMode): PermissionMode {
  return access === "read" ? "plan" : parentMode
}

function childPrompt(context: string, task: string): string {
  return `# Context\n${context}\n\n# Assignment\n${task}`
}

function registerTask(
  job: BackgroundAgentJob,
  item: TaskItem,
  ctx: SessionToolContext,
  state: ActivityState,
  cwd: () => string,
  child: () => AgentSession | undefined,
): void {
  registerBackgroundTask({
    kind: "agent",
    id: job.id,
    ownerId: job.ownerId,
    title: item.task,
    startedAt: job.startedAt,
    role: item.isolation === "worktree" ? "task agent · worktree" : "task agent",
    model: ctx.session.model,
    get cwd() {
      return cwd()
    },
    childSessionId: () => child()?.id,
    send: (message) => sendAgentGuidance(job, message, "user"),
    state: () =>
      job.done
        ? {
            running: false,
            ok: job.outcome?.status === "completed" && job.delivery !== "dead_lettered",
            detail: job.detail,
          }
        : { running: true },
    output: () => taskOutput(job),
    snapshot: () => {
      const now = Date.now()
      return {
        activity: job.activity,
        queued: !job.done && job.runningAt === undefined,
        queuedMs: (job.runningAt ?? job.finishedAt ?? now) - job.startedAt,
        elapsedMs: job.runningAt === undefined ? 0 : (job.finishedAt ?? now) - job.runningAt,
        toolCount: state.toolCalls.size,
        contextTokens: child()?.currentContextTokens,
      }
    },
    stop: async () => {
      await stopJob(job, "user")
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
  let worktree: ManagedWorktree | undefined
  let child: AgentSession | undefined
  let terminal: TaskTerminal | undefined
  const record = (text: string): void => appendAgentTranscript(job, text)
  const cleanupFailure = (error: unknown): void => {
    const message = describeError(error)
    record(`\nTask agent cleanup failed: ${message}\n`)
    terminal = { outcome: { status: "failed" }, detail: `failed to clean up task resources: ${message}` }
    setAgentActivity(job, "Cleanup failed")
  }
  const timeoutMinutes = settings().agents.timeoutMinutes
  try {
    await taskScheduler().acquire(controller.signal)
    acquired = true
    if (controller.signal.aborted) throw new Error("task cancelled before it started")
    startAgentJob(job, timeoutMinutes * 60_000)
    deadline = setTimeout(() => {
      timedOut = true
      controller.abort()
      setAgentActivity(job, "Deadline reached; stopping…")
      record(`\nTask reached its ${timeoutMinutes}-minute deadline.\n`)
    }, timeoutMinutes * 60_000)
    deadline.unref()

    worktree =
      item.isolation === "worktree"
        ? await createManagedWorktree(ctx.session.cwd, item.task, controller.signal)
        : undefined
    if (worktree) {
      setCwd(worktree.cwd)
      record(`Isolated worktree: ${compactPath(worktree.path)}\nBranch: ${worktree.branch}\n\n`)
    }
    if (controller.signal.aborted) throw new Error("task cancelled before it started")

    const thinking = await resolveThinking(
      ctx.session.provider,
      ctx.session.profileId,
      ctx.session.model,
      item.thinking ?? ctx.session.thinking,
    )
    const taskSession = new AgentSession({
      kind: "subagent",
      cwd: worktree?.cwd ?? ctx.session.cwd,
      provider: ctx.session.provider,
      profileId: ctx.session.profileId,
      model: ctx.session.model,
      modelInputModalities: ctx.session.modelInputModalities,
      thinking,
      interactive: false,
      persist: false,
      inheritedDenyMode: ctx.session.mode,
      ...(item.access === "write" && !worktree
        ? { workspaceUndo: ctx.session.workspaceUndo, trackUndoPrompts: false }
        : {}),
    })
    child = taskSession
    setChild(taskSession)
    taskSession.setMode(childMode(item.access, ctx.session.mode))
    const abortChild = (): void => {
      taskSession.suppressAsyncDeliveries()
      taskSession.interrupt()
    }
    controller.signal.addEventListener("abort", abortChild)
    let outcome: TaskDriveOutcome
    try {
      outcome = await driveTaskToQuiescence(
        taskSession,
        { text: childPrompt(context, item.task), images: [] },
        (event) => {
          if (job.done) return
          touchAgentActivity(job)
          activity(event, taskSession, state, record, (value) => setAgentActivity(job, value))
        },
        controller.signal,
      )
    } finally {
      controller.signal.removeEventListener("abort", abortChild)
    }

    if (timedOut) {
      setAgentActivity(job, "Timed out")
      terminal = { outcome: { status: "timed_out" }, detail: `timed out after ${timeoutMinutes}m` }
    } else if (outcome.status === "interrupted") {
      setAgentActivity(job, "Interrupted")
      terminal = { outcome: { status: "interrupted" }, detail: "interrupted" }
    } else if (outcome.status === "failed") {
      setAgentActivity(job, "Failed")
      record(`\nTask agent failed: ${outcome.error}\n`)
      terminal = { outcome: { status: "failed" }, detail: `failed: ${outcome.error}` }
    } else {
      setAgentActivity(job, "Report ready")
      terminal = { outcome: { status: "completed", report: outcome.report }, detail: "completed" }
    }
  } catch (error) {
    if (timedOut) {
      setAgentActivity(job, "Timed out")
      terminal = { outcome: { status: "timed_out" }, detail: `timed out after ${timeoutMinutes}m` }
    } else if (controller.signal.aborted) {
      setAgentActivity(job, "Interrupted")
      terminal = { outcome: { status: "interrupted" }, detail: "interrupted" }
    } else {
      const message = describeError(error)
      setAgentActivity(job, "Failed")
      record(`\nTask agent failed: ${message}\n`)
      terminal = { outcome: { status: "failed" }, detail: `failed: ${message}` }
    }
  } finally {
    if (deadline) clearTimeout(deadline)
    if (child) {
      try {
        await child.cancelAndReapAsyncWork()
      } catch (error) {
        cleanupFailure(error)
        try {
          await child.cancelAndReapAsyncWork(0)
        } catch (retryError) {
          cleanupFailure(retryError)
        }
      }
      child.disposeAsyncDelivery()
      try {
        child.disposeToolResources()
      } catch (error) {
        cleanupFailure(error)
      }
    }
    if (acquired) taskScheduler().release()
    terminal ??= { outcome: { status: "failed" }, detail: "task ended without an outcome" }
    await finishTask(job, terminal, ctx.session.directory, worktree)
  }
}

export function spawnTask(item: TaskItem, context: string, ctx: SessionToolContext): BackgroundAgentJob {
  const controller = new AbortController()
  let child: AgentSession | undefined
  let cwd = ctx.session.cwd
  const job = createAgentJob("agent", {
    id: item.name,
    ownerId: ctx.session.id,
    task: item.task,
    stop: () => {
      controller.abort()
      child?.suppressAsyncDeliveries()
      child?.interrupt()
    },
    send: (message, source) => child?.steer(`${source === "user" ? "User" : "Parent"} guidance:\n${message}`) ?? false,
  })
  attachJobLog(job, createJobLog(ctx.session.directory, `agent-${job.id}`))
  const state: ActivityState = {
    streamedText: false,
    activity: "Queued…",
    toolCalls: new Set(),
    updatedCalls: new Set(),
  }
  setAgentActivity(job, state.activity)
  registerTask(
    job,
    item,
    ctx,
    state,
    () => cwd,
    () => child,
  )
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
