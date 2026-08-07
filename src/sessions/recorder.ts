import { appendFile, mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { AgentEvent } from "../agent/events"
import { projectSessionsDir } from "../config/paths"
import { describeError } from "../lib/error"
import type { ConversationItem } from "../providers/types"
import { isPersistable } from "./records"
import type { SessionMeta, SessionRecord } from "./types"

function line(record: SessionRecord): string {
  return `${JSON.stringify(record)}\n`
}

export class SessionRecorder {
  private path: string | undefined
  private pending: SessionMeta | undefined
  private queue: Promise<void> = Promise.resolve()
  private failed = false

  constructor(private readonly onError: (message: string) => void) {}

  start(meta: SessionMeta): void {
    this.path = undefined
    this.pending = meta
    this.failed = false
  }

  attach(path: string): void {
    this.path = path
    this.pending = undefined
    this.failed = false
  }

  item(item: ConversationItem): void {
    this.append({ type: "item", item })
  }

  event(event: AgentEvent): void {
    if (!isPersistable(event)) return
    this.append({ type: "event", event })
  }

  private append(record: SessionRecord): void {
    if (this.failed) return
    const meta = this.pending
    if (meta) {
      this.path = join(projectSessionsDir(meta.cwd), `${meta.id}.jsonl`)
      this.pending = undefined
    }
    const path = this.path
    if (!path) return
    this.queue = this.queue.then(() => this.write(path, record, meta)).catch((error: unknown) => this.fail(error))
  }

  private async write(path: string, record: SessionRecord, meta: SessionMeta | undefined): Promise<void> {
    if (meta) await mkdir(dirname(path), { recursive: true })
    const payload = meta ? line({ type: "meta", meta }) + line(record) : line(record)
    await appendFile(path, payload, { mode: 0o600 })
  }

  private fail(error: unknown): void {
    this.failed = true
    this.onError(`session not saved: ${describeError(error)}`)
  }
}
