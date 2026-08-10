import { setTimeout as sleep } from "node:timers/promises"
import { createRedactedStream, redactText, type RedactedStream } from "../secrets/redactor"
import { backgroundTasksChanged, listBackgroundTasks, subscribeBackgroundTasks } from "./registry"

const MAX_PENDING_CHARS = 2_000_000
const MAX_HISTORY_CHARS = 200_000
const STOP_WAIT_MS = 2_000

export interface BackgroundJob {
  id: string
  pending: string
  dropped: boolean
  history: string
  done: boolean
  detail: string
  completion: Promise<void>
  waiters: Set<() => void>
  stop(): void
}

const jobs = new Map<string, BackgroundJob>()
const completions = new WeakMap<BackgroundJob, () => void>()
const redactors = new WeakMap<BackgroundJob, RedactedStream>()
let nextId = 1
let cleanupRegistered = false

function registerCleanup(): void {
  if (cleanupRegistered) return
  cleanupRegistered = true
  subscribeBackgroundTasks(() => {
    const listed = new Set(listBackgroundTasks().map((task) => task.id))
    for (const [id, job] of jobs) {
      if (!listed.has(id) && job.done && !job.pending) jobs.delete(id)
    }
  })
}

function wake(job: BackgroundJob): void {
  for (const waiter of [...job.waiters]) waiter()
  backgroundTasksChanged()
}

export function createJob(prefix: string, stop: () => void): BackgroundJob {
  registerCleanup()
  const { promise: completion, resolve: complete } = Promise.withResolvers<void>()
  const job: BackgroundJob = {
    id: `${prefix}-${nextId++}`,
    pending: "",
    dropped: false,
    history: "",
    done: false,
    detail: "still running",
    completion,
    waiters: new Set(),
    stop,
  }
  completions.set(job, complete)
  redactors.set(job, createRedactedStream())
  jobs.set(job.id, job)
  return job
}

function append(job: BackgroundJob, text: string): void {
  if (!text) return
  job.pending += text
  if (job.pending.length > MAX_PENDING_CHARS) {
    job.pending = job.pending.slice(-MAX_PENDING_CHARS)
    job.dropped = true
  }
  job.history += text
  if (job.history.length > MAX_HISTORY_CHARS * 2) job.history = job.history.slice(-MAX_HISTORY_CHARS)
  wake(job)
}

export function appendJobOutput(job: BackgroundJob, text: string): void {
  const redactor = redactors.get(job)
  if (!redactor) throw new Error(`background job ${job.id} is no longer accepting output`)
  append(job, redactor.write(text))
}

export function finishJob(job: BackgroundJob, detail: string): void {
  if (job.done) return
  const redactor = redactors.get(job)
  if (!redactor) throw new Error(`background job ${job.id} has no redaction stream`)
  append(job, redactor.end())
  redactors.delete(job)
  job.done = true
  job.detail = redactText(detail)
  completions.get(job)?.()
  wake(job)
}

export function getJob(id: string): BackgroundJob | undefined {
  return jobs.get(id)
}

export function readJobOutput(job: BackgroundJob): { text: string; dropped: boolean } {
  const { pending, dropped } = job
  job.pending = ""
  job.dropped = false
  return { text: pending, dropped }
}

export async function waitForJob(job: BackgroundJob, waitMs: number, signal?: AbortSignal): Promise<void> {
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

export async function stopJob(job: BackgroundJob): Promise<void> {
  if (job.done) return
  job.stop()
  await Promise.race([job.completion, sleep(STOP_WAIT_MS, undefined, { ref: false })])
}

export function jobStatus(job: BackgroundJob): string {
  return job.done ? job.detail : "still running"
}
