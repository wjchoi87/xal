import { appendFile, mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { AgentEvent } from "../agent/events"
import type { SessionKind } from "../agent/types"
import type { StreamEvent, ThinkingEffort, Usage } from "../providers/types"
import { appInfo } from "../app-info"
import { profilerDir } from "../config/paths"
import { events, type AppEvent } from "../events"
import { describeError } from "../lib/error"
import { redactText } from "../secrets/redactor"

type ProfileRecord =
  | { type: "run_started"; version: string; pid: number; argv: string[] }
  | {
      type: "session_created"
      sessionId: string
      kind: SessionKind
      provider: string
      model: string
      thinking?: ThinkingEffort
      cwd: string
    }
  | { type: "agent_event"; sessionId: string; kind: SessionKind; event: AgentEvent }
  | {
      type: "provider_request_started"
      requestId: string
      sessionId: string
      kind: SessionKind
      phase: ProviderPhase
      provider: string
      model: string
      thinking?: ThinkingEffort
      attempt: number
    }
  | {
      type: "provider_first_event"
      requestId: string
      event: StreamEvent["type"]
      elapsedMs: number
    }
  | {
      type: "provider_request_finished"
      requestId: string
      outcome: ProfileOutcome
      elapsedMs: number
      usage?: Usage
      error?: string
    }
  | {
      type: "tool_batch_started"
      batchId: string
      sessionId: string
      kind: SessionKind
      concurrency: ToolConcurrency
      count: number
      tools: string[]
    }
  | {
      type: "tool_batch_finished"
      batchId: string
      outcome: ProfileOutcome
      elapsedMs: number
      error?: string
    }
  | { type: "app_event"; event: AppEvent }
  | { type: "job_created"; jobId: string }
  | { type: "job_finished"; jobId: string; detail: string }

type ProviderPhase = "turn" | "compaction"
type ProfileOutcome = "completed" | "failed" | "interrupted"
type ToolConcurrency = "shared" | "exclusive"

export interface ProviderRequestProfile {
  requestId: string
  startedAt: number
}

export interface ToolBatchProfile {
  batchId: string
  startedAt: number
}

const enabled = (process.env.ENABLE_PROFILER ?? "").trim() !== ""

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
  thinking: ThinkingEffort | undefined,
  cwd: string,
): void {
  if (!enabled) return
  record({
    type: "session_created",
    sessionId,
    kind,
    provider: redactText(provider),
    model: redactText(model),
    ...(thinking === undefined ? {} : { thinking }),
    cwd: redactText(cwd),
  })
}

export function profileAgentEvent(sessionId: string, kind: SessionKind, event: AgentEvent): void {
  if (!enabled) return
  if (kind === "primary" && (event.type === "session_started" || event.type === "user_message")) {
    nameProfile(sessionId)
  }
  if (
    event.type === "text_delta" ||
    event.type === "reasoning_summary_delta" ||
    event.type === "reasoning_delta" ||
    event.type === "tool_updated"
  ) {
    return
  }
  record({ type: "agent_event", sessionId, kind, event })
}

export function profileProviderRequestStarted(
  sessionId: string,
  kind: SessionKind,
  phase: ProviderPhase,
  provider: string,
  model: string,
  thinking: ThinkingEffort | undefined,
  attempt: number,
): ProviderRequestProfile {
  const profile = { requestId: crypto.randomUUID(), startedAt: Date.now() }
  record({
    type: "provider_request_started",
    requestId: profile.requestId,
    sessionId,
    kind,
    phase,
    provider: redactText(provider),
    model: redactText(model),
    ...(thinking === undefined ? {} : { thinking }),
    attempt,
  })
  return profile
}

export function profileProviderFirstEvent(profile: ProviderRequestProfile, event: StreamEvent["type"]): void {
  record({
    type: "provider_first_event",
    requestId: profile.requestId,
    event,
    elapsedMs: Date.now() - profile.startedAt,
  })
}

export function profileProviderRequestFinished(
  profile: ProviderRequestProfile,
  outcome: ProfileOutcome,
  usage?: Usage,
  error?: string,
): void {
  record({
    type: "provider_request_finished",
    requestId: profile.requestId,
    outcome,
    elapsedMs: Date.now() - profile.startedAt,
    ...(usage === undefined ? {} : { usage }),
    ...(error === undefined ? {} : { error: redactText(error) }),
  })
}

export function profileToolBatchStarted(
  sessionId: string,
  kind: SessionKind,
  concurrency: ToolConcurrency,
  tools: string[],
): ToolBatchProfile {
  const profile = { batchId: crypto.randomUUID(), startedAt: Date.now() }
  record({
    type: "tool_batch_started",
    batchId: profile.batchId,
    sessionId,
    kind,
    concurrency,
    count: tools.length,
    tools: tools.map(redactText),
  })
  return profile
}

export function profileToolBatchFinished(profile: ToolBatchProfile, outcome: ProfileOutcome, error?: string): void {
  record({
    type: "tool_batch_finished",
    batchId: profile.batchId,
    outcome,
    elapsedMs: Date.now() - profile.startedAt,
    ...(error === undefined ? {} : { error: redactText(error) }),
  })
}

export function profileJobCreated(jobId: string): void {
  record({ type: "job_created", jobId })
}

export function profileJobFinished(jobId: string, detail: string): void {
  record({ type: "job_finished", jobId, detail })
}
