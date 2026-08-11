import { appendFile, mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { AgentEvent } from "../agent/events"
import type { HistoryItem } from "../agent/history"
import { projectSessionsDir } from "../config/paths"
import { describeError } from "../lib/error"
import { isPersistable } from "./records"
import type { SessionMeta, SessionRecord } from "./types"

function line(record: SessionRecord): string {
  return `${JSON.stringify(record)}\n`
}

export class SessionRecorder {
  private path: string | undefined
  private pending: { meta: SessionMeta; cwd: string } | undefined
  private queue: Promise<void> = Promise.resolve()
  private failed = false

  constructor(private readonly onError: (message: string) => void) {}

  start(meta: SessionMeta, cwd: string): void {
    this.path = undefined
    this.pending = { meta, cwd }
    this.failed = false
  }

  attach(path: string): void {
    this.path = path
    this.pending = undefined
    this.failed = false
  }

  item(item: HistoryItem): void {
    this.append({ type: "item", item })
  }

  event(event: AgentEvent): void {
    if (!isPersistable(event)) return
    this.append({ type: "event", event })
  }

  eventAndWait(event: AgentEvent): Promise<void> {
    if (!isPersistable(event)) return Promise.reject(new Error("session event cannot be persisted"))
    return this.appendAndWait({ type: "event", event })
  }

  private append(record: SessionRecord): void {
    if (this.failed) return
    void this.appendAndWait(record)
  }

  private appendAndWait(record: SessionRecord): Promise<void> {
    if (this.failed) return Promise.reject(new Error("session recorder is unavailable"))
    const pending = this.pending
    if (pending) {
      this.path = join(projectSessionsDir(pending.cwd), `${pending.meta.id}.jsonl`)
      this.pending = undefined
    }
    const path = this.path
    if (!path) return Promise.resolve()
    const writing = this.queue.then(() => {
      if (this.failed) throw new Error("session recorder is unavailable")
      return this.write(path, record, pending?.meta)
    })
    this.queue = writing.catch((error: unknown) => this.fail(error))
    return writing
  }

  private async write(path: string, record: SessionRecord, meta: SessionMeta | undefined): Promise<void> {
    if (meta) await mkdir(dirname(path), { recursive: true })
    const payload = meta ? line({ type: "meta", meta }) + line(record) : line(record)
    await appendFile(path, payload, { mode: 0o600 })
  }

  private fail(error: unknown): void {
    if (this.failed) return
    this.failed = true
    this.onError(`session not saved: ${describeError(error)}`)
  }
}
