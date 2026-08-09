import { setTimeout as sleep } from "node:timers/promises"
import {
  backgroundTasksChanged,
  listBackgroundTasks,
  registerBackgroundTask,
  subscribeBackgroundTasks,
} from "../../background/registry"
import { killTree, type CommandProcess } from "./process"

const MAX_PENDING_CHARS = 2_000_000
const MAX_HISTORY_CHARS = 200_000
const KILL_WAIT_MS = 2_000

export interface BashJob {
  id: string
  command: string
  proc: CommandProcess
  pending: string
  dropped: boolean
  history: string
  status: "running" | "exited"
  exitCode: number | null
  done: Promise<void>
  waiters: Set<() => void>
}

const jobs = new Map<string, BashJob>()
let nextId = 1
let cleanupRegistered = false

function registerCleanup(): void {
  if (cleanupRegistered) return
  cleanupRegistered = true
  process.on("exit", () => {
    for (const job of jobs.values()) killTree(job.proc)
  })
  subscribeBackgroundTasks(() => {
    const listed = new Set(listBackgroundTasks().map((task) => task.id))
    for (const [id, job] of jobs) {
      if (!listed.has(id) && job.status === "exited" && !job.pending) jobs.delete(id)
    }
  })
}

function wake(job: BashJob): void {
  for (const waiter of [...job.waiters]) waiter()
  backgroundTasksChanged()
}

export function startJob(command: string, proc: CommandProcess): BashJob {
  registerCleanup()
  let finish = (): void => {}
  const done = new Promise<void>((resolve) => {
    finish = resolve
  })
  const job: BashJob = {
    id: `bash-${nextId++}`,
    command,
    proc,
    pending: "",
    dropped: false,
    history: "",
    status: "running",
    exitCode: null,
    done,
    waiters: new Set(),
  }
  const collect = (chunk: Buffer): void => {
    const text = chunk.toString()
    job.pending += text
    if (job.pending.length > MAX_PENDING_CHARS) {
      job.pending = job.pending.slice(-MAX_PENDING_CHARS)
      job.dropped = true
    }
    job.history += text
    if (job.history.length > MAX_HISTORY_CHARS * 2) job.history = job.history.slice(-MAX_HISTORY_CHARS)
    wake(job)
  }
  proc.stdout.on("data", collect)
  proc.stderr.on("data", collect)
  proc.once("error", (error) => {
    const message = `failed to launch: ${error.message}`
    job.pending += `${job.pending ? "\n" : ""}${message}`
    job.history += `${job.history ? "\n" : ""}${message}`
    job.status = "exited"
    finish()
    wake(job)
  })
  proc.once("close", (code) => {
    job.status = "exited"
    job.exitCode = code
    finish()
    wake(job)
  })
  jobs.set(job.id, job)
  registerBackgroundTask({
    id: job.id,
    title: command,
    startedAt: Date.now(),
    state: () => {
      if (job.status === "running") return { running: true }
      if (job.exitCode !== null) return { running: false, ok: job.exitCode === 0, detail: `exit ${job.exitCode}` }
      return { running: false, ok: false, detail: "killed" }
    },
    output: () => job.history,
    stop: () => killJob(job),
  })
  return job
}

export function getJob(id: string): BashJob | undefined {
  return jobs.get(id)
}

export function readJobOutput(job: BashJob): { text: string; dropped: boolean } {
  const { pending, dropped } = job
  job.pending = ""
  job.dropped = false
  return { text: pending, dropped }
}

export async function waitForJob(job: BashJob, waitMs: number, signal?: AbortSignal): Promise<void> {
  if (waitMs <= 0 || job.pending || job.status === "exited" || signal?.aborted) return
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

export async function killJob(job: BashJob): Promise<void> {
  if (job.status === "exited") return
  killTree(job.proc)
  await Promise.race([job.done, sleep(KILL_WAIT_MS, undefined, { ref: false })])
}

export function jobStatus(job: BashJob): string {
  if (job.status === "running") return "still running"
  if (job.exitCode !== null) return `exited with code ${job.exitCode}`
  return "terminated by signal"
}
