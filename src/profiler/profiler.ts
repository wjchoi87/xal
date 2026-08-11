import { appendFile, mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { AgentEvent } from "../agent/events"
import type { SessionKind } from "../agent/types"
import { appInfo } from "../app-info"
import { profilerDir } from "../config/paths"
import { events, type AppEvent } from "../events"
import { describeError } from "../lib/error"
import { redactText } from "../secrets/redactor"

type ProfileRecord =
  | { type: "run_started"; version: string; pid: number; argv: string[] }
  | { type: "session_created"; sessionId: string; kind: SessionKind; provider: string; model: string; cwd: string }
  | { type: "agent_event"; sessionId: string; kind: SessionKind; event: AgentEvent }
  | { type: "first_delta"; sessionId: string; kind: SessionKind; delta: AgentEvent["type"] }
  | { type: "app_event"; event: AppEvent }
  | { type: "job_created"; jobId: string }
  | { type: "job_finished"; jobId: string; detail: string }

const enabled = (process.env.ENABLE_PROFILER ?? "").trim() !== ""
const deltaTypes = new Set<AgentEvent["type"]>(["text_delta", "reasoning_summary_delta", "reasoning_delta"])
const awaitingDelta = new Set<string>()

let path: string | undefined
let pending: string[] = []
let queue: Promise<void> = Promise.resolve()
let failed = false

function fail(error: unknown): void {
  if (failed) return
  failed = true
  console.error(redactText(`profiler stopped: ${describeError(error)}`))
}

function enqueue(task: () => Promise<void>): void {
  const writing = queue.then(async () => {
    if (failed) return
    await task()
  })
  queue = writing.catch(fail)
}

function nameProfile(name: string): void {
  if (!enabled || failed || path) return
  const file = join(profilerDir(), `${name}.jsonl`)
  path = file
  const lines = pending
  pending = []
  enqueue(async () => {
    await mkdir(dirname(file), { recursive: true })
    if (lines.length > 0) await appendFile(file, lines.join(""), { mode: 0o600 })
  })
}

function record(entry: ProfileRecord): void {
  if (!enabled || failed) return
  const line = `${JSON.stringify({ at: Date.now(), ...entry })}\n`
  const file = path
  if (!file) {
    pending.push(line)
    return
  }
  enqueue(() => appendFile(file, line, { mode: 0o600 }))
}

export function startProfiler(): void {
  if (!enabled) return
  record({
    type: "run_started",
    version: appInfo.version,
    pid: process.pid,
    argv: process.argv.slice(2).map((arg) => redactText(arg)),
  })
  events.subscribe((event) => record({ type: "app_event", event }))
}

export async function stopProfiler(): Promise<string | undefined> {
  if (pending.length > 0) {
    const stamp = new Date().toISOString().replaceAll(":", "-").replace(".", "-")
    nameProfile(`run-${stamp}-${process.pid}`)
  }
  await queue
  return path
}

export function profileSessionCreated(
  sessionId: string,
  kind: SessionKind,
  provider: string,
  model: string,
  cwd: string,
): void {
  if (!enabled) return
  record({
    type: "session_created",
    sessionId,
    kind,
    provider: redactText(provider),
    model: redactText(model),
    cwd: redactText(cwd),
  })
}

export function profileAgentEvent(sessionId: string, kind: SessionKind, event: AgentEvent): void {
  if (!enabled) return
  if (kind === "primary" && (event.type === "session_started" || event.type === "user_message")) {
    nameProfile(sessionId)
  }
  if (event.type === "state_changed" && event.state === "streaming") awaitingDelta.add(sessionId)
  if (deltaTypes.has(event.type)) {
    if (!awaitingDelta.delete(sessionId)) return
    record({ type: "first_delta", sessionId, kind, delta: event.type })
    return
  }
  if (event.type === "tool_updated") return
  record({ type: "agent_event", sessionId, kind, event })
}

export function profileJobCreated(jobId: string): void {
  record({ type: "job_created", jobId })
}

export function profileJobFinished(jobId: string, detail: string): void {
  record({ type: "job_finished", jobId, detail })
}
