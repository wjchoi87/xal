import { setTimeout as sleep } from "node:timers/promises"
import { profileJobCreated, profileJobFinished } from "../profiler/profiler"
import { createRedactedStream, redactText, type RedactedStream } from "../secrets/redactor"
import { backgroundTasksChanged, listBackgroundTasks, removeBackgroundTask, subscribeBackgroundTasks } from "./registry"

const MAX_PENDING_CHARS = 2_000_000
const MAX_HISTORY_CHARS = 200_000
const STOP_WAIT_MS = 2_000
const AGENT_RETENTION_MS = 5 * 60 * 1_000

interface BackgroundJobBase {
  id: string
  startedAt: number
  finishedAt?: number
  done: boolean
  detail: string
  completion: Promise<void>
  stop(): void
}

export interface BackgroundProcessJob extends BackgroundJobBase {
  kind: "process"
  pending: string
  dropped: boolean
  history: string
  consumed: boolean
  waiters: Set<() => void>
}

export type BackgroundAgentOutcome =
  { status: "completed"; report: string } | { status: "failed" } | { status: "interrupted" } | { status: "timed_out" }

export interface BackgroundAgentControls {
  id?: string
  ownerId: string
  task: string
  stop(): void
  send(message: string): boolean
}

export interface BackgroundAgentJob extends BackgroundJobBase {
  kind: "agent"
  ownerId: string
  task: string
  phase: "queued" | "running"
  deadlineAt?: number
  lastActivityAt: number
  transcript: string
  activity: string
  outcome?: BackgroundAgentOutcome
  consumed: boolean
  send(message: string): boolean
}

export type BackgroundJob = BackgroundProcessJob | BackgroundAgentJob

export type CollectedAgentOutcome = BackgroundAgentOutcome | { status: "already_collected" }

const jobs = new Map<string, BackgroundJob>()
const completions = new WeakMap<BackgroundJob, () => void>()
const redactors = new WeakMap<BackgroundJob, RedactedStream>()
const agentEvictions = new Map<string, ReturnType<typeof setTimeout>>()
let nextId = 1
let cleanupRegistered = false

function registerCleanup(): void {
  if (cleanupRegistered) return
  cleanupRegistered = true
  subscribeBackgroundTasks(() => {
    const listed = new Set(listBackgroundTasks().map((task) => task.id))
    for (const [id, job] of jobs) {
      if (listed.has(id) || !job.done || !job.consumed) continue
      jobs.delete(id)
      clearTimeout(agentEvictions.get(id))
      agentEvictions.delete(id)
    }
  })
}

function scheduleAgentEviction(job: BackgroundAgentJob): void {
  if (agentEvictions.has(job.id)) return
  const timer = setTimeout(() => {
    agentEvictions.delete(job.id)
    removeBackgroundTask(job.id)
  }, AGENT_RETENTION_MS)
  timer.unref()
  agentEvictions.set(job.id, timer)
}

function jobId(prefix: string, preferred?: string): string {
  const base = preferred?.trim()
  if (base) {
    if (!jobs.has(base)) return base
    let suffix = 2
    while (jobs.has(`${base}-${suffix}`)) suffix += 1
    return `${base}-${suffix}`
  }
  let id = `${prefix}-${nextId++}`
  while (jobs.has(id)) id = `${prefix}-${nextId++}`
  return id
}

function createBase(
  prefix: string,
  stop: () => void,
  preferredId?: string,
): { base: BackgroundJobBase; complete: () => void } {
  const { promise: completion, resolve: complete } = Promise.withResolvers<void>()
  return {
    base: {
      id: jobId(prefix, preferredId),
      startedAt: Date.now(),
      done: false,
      detail: "still running",
      completion,
      stop,
    },
    complete,
  }
}

function registerJob(job: BackgroundJob, complete: () => void): void {
  registerCleanup()
  completions.set(job, complete)
  redactors.set(job, createRedactedStream())
  jobs.set(job.id, job)
  profileJobCreated(job.id)
}

export function createProcessJob(prefix: string, stop: () => void): BackgroundProcessJob {
  const created = createBase(prefix, stop)
  const job: BackgroundProcessJob = {
    ...created.base,
    kind: "process",
    pending: "",
    dropped: false,
    history: "",
    consumed: false,
    waiters: new Set(),
  }
  registerJob(job, created.complete)
  return job
}

export function createAgentJob(prefix: string, controls: BackgroundAgentControls): BackgroundAgentJob {
  const created = createBase(prefix, controls.stop, controls.id)
  const job: BackgroundAgentJob = {
    ...created.base,
    kind: "agent",
    ownerId: controls.ownerId,
    task: redactText(controls.task),
    phase: "queued",
    lastActivityAt: created.base.startedAt,
    transcript: "",
    activity: "Initializing…",
    consumed: false,
    send: controls.send,
  }
  registerJob(job, created.complete)
  return job
}

function redactorOf(job: BackgroundJob): RedactedStream {
  const redactor = redactors.get(job)
  if (!redactor) throw new Error(`background job ${job.id} is no longer accepting output`)
  return redactor
}

function wakeProcess(job: BackgroundProcessJob): void {
  for (const waiter of [...job.waiters]) waiter()
  backgroundTasksChanged()
}

function appendProcess(job: BackgroundProcessJob, text: string): void {
  if (!text) return
  job.pending += text
  if (job.pending.length > MAX_PENDING_CHARS) {
    job.pending = job.pending.slice(-MAX_PENDING_CHARS)
    job.dropped = true
  }
  job.history += text
  if (job.history.length > MAX_HISTORY_CHARS * 2) job.history = job.history.slice(-MAX_HISTORY_CHARS)
  wakeProcess(job)
}

export function appendProcessOutput(job: BackgroundProcessJob, text: string): void {
  appendProcess(job, redactorOf(job).write(text))
}

function appendTranscript(job: BackgroundAgentJob, text: string): void {
  if (!text) return
  job.transcript += text
  if (job.transcript.length > MAX_HISTORY_CHARS * 2) job.transcript = job.transcript.slice(-MAX_HISTORY_CHARS)
  backgroundTasksChanged()
}

export function appendAgentTranscript(job: BackgroundAgentJob, text: string): void {
  job.lastActivityAt = Date.now()
  appendTranscript(job, redactorOf(job).write(text))
}

export function setAgentActivity(job: BackgroundAgentJob, activity: string): void {
  job.lastActivityAt = Date.now()
  job.activity = redactText(activity)
  backgroundTasksChanged()
}

export function startAgentJob(job: BackgroundAgentJob, timeoutMs: number): void {
  if (job.done) return
  job.phase = "running"
  job.deadlineAt = Date.now() + timeoutMs
  setAgentActivity(job, "Initializing…")
}

export function touchAgentActivity(job: BackgroundAgentJob): void {
  if (job.done) return
  job.lastActivityAt = Date.now()
}

function completeJob(job: BackgroundJob, detail: string, remove: boolean): void {
  const complete = completions.get(job)
  if (!complete) throw new Error(`background job ${job.id} has no completion resolver`)
  job.done = true
  job.finishedAt = Date.now()
  job.detail = redactText(detail)
  profileJobFinished(job.id, job.detail)
  completions.delete(job)
  complete()
  if (remove) removeBackgroundTask(job.id)
  else backgroundTasksChanged()
}

export function finishProcessJob(job: BackgroundProcessJob, detail: string): void {
  if (job.done) return
  appendProcess(job, redactorOf(job).end())
  redactors.delete(job)
  completeJob(job, detail, true)
  wakeProcess(job)
}

export function finishAgentJob(job: BackgroundAgentJob, outcome: BackgroundAgentOutcome, detail: string): void {
  if (job.done) return
  appendTranscript(job, redactorOf(job).end())
  redactors.delete(job)
  job.outcome = outcome.status === "completed" ? { status: "completed", report: redactText(outcome.report) } : outcome
  completeJob(job, detail, false)
  if (job.consumed && jobs.get(job.id) === job) scheduleAgentEviction(job)
}

export function getJob(id: string): BackgroundJob | undefined {
  return jobs.get(id)
}

export function listJobs(): BackgroundJob[] {
  return [...jobs.values()]
}

export function runningAgentJobs(ownerId: string): BackgroundAgentJob[] {
  return [...jobs.values()].filter(
    (job): job is BackgroundAgentJob => job.kind === "agent" && job.ownerId === ownerId && !job.done,
  )
}

export function unsettledAgentJobs(ownerId: string): BackgroundAgentJob[] {
  return [...jobs.values()].filter(
    (job): job is BackgroundAgentJob => job.kind === "agent" && job.ownerId === ownerId && (!job.done || !job.consumed),
  )
}

export function readProcessOutput(job: BackgroundProcessJob): { text: string; dropped: boolean } {
  const { pending, dropped } = job
  job.pending = ""
  job.dropped = false
  if (job.done) job.consumed = true
  backgroundTasksChanged()
  return { text: pending, dropped }
}

export function collectAgentOutcome(job: BackgroundAgentJob): CollectedAgentOutcome {
  if (!job.done || !job.outcome) throw new Error(`background agent ${job.id} has not finished`)
  if (job.consumed) return { status: "already_collected" }
  job.consumed = true
  scheduleAgentEviction(job)
  backgroundTasksChanged()
  return job.outcome
}

export function suppressAgentOutcome(job: BackgroundAgentJob): void {
  if (job.consumed) return
  job.consumed = true
  if (job.done) scheduleAgentEviction(job)
  backgroundTasksChanged()
}

export function discardSettledAgentJobs(ownerId: string): void {
  for (const job of [...jobs.values()]) {
    if (job.kind !== "agent" || job.ownerId !== ownerId || !job.done) continue
    suppressAgentOutcome(job)
    removeBackgroundTask(job.id)
  }
}

export async function waitForProcessOutput(
  job: BackgroundProcessJob,
  waitMs: number,
  signal?: AbortSignal,
): Promise<void> {
  if (waitMs <= 0 || job.pending || job.done || signal?.aborted) return
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, waitMs)
    function done(): void {
      clearTimeout(timer)
      job.waiters.delete(done)
      signal?.removeEventListener("abort", done)
      resolve()
    }
    job.waiters.add(done)
    signal?.addEventListener("abort", done)
  })
}

export async function waitForAgentCompletion(
  job: BackgroundAgentJob,
  waitMs: number,
  signal?: AbortSignal,
): Promise<void> {
  if (waitMs <= 0 || job.done || signal?.aborted) return
  const { promise, resolve } = Promise.withResolvers<void>()
  const timer = setTimeout(resolve, waitMs)
  const abort = (): void => resolve()
  signal?.addEventListener("abort", abort)
  try {
    await Promise.race([job.completion, promise])
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener("abort", abort)
  }
}

export async function stopJob(job: BackgroundJob): Promise<void> {
  if (job.done) return
  job.stop()
  if (job.kind === "agent") setAgentActivity(job, "Stopping…")
  await Promise.race([job.completion, sleep(STOP_WAIT_MS, undefined, { ref: false })])
}

export function jobStatus(job: BackgroundJob): string {
  return job.done ? job.detail : "still running"
}
