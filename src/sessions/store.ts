import { readdir } from "node:fs/promises"
import { join } from "node:path"
import type { AgentEvent } from "../agent/events"
import { projectSessionsDir, sessionsDir } from "../config/paths"
import type { ConversationItem } from "../providers/types"
import { parseRecord } from "./records"
import type { LoadedSession, SessionMeta, SessionSummary } from "./types"

const TITLE_WIDTH = 120

function title(text: string): string {
  const line = text.split("\n", 1)[0]?.trim() ?? ""
  return line.length > TITLE_WIDTH ? `${line.slice(0, TITLE_WIDTH - 1)}…` : line
}

async function sessionFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir)
    return entries.filter((entry) => entry.endsWith(".jsonl")).map((entry) => join(dir, entry))
  } catch {
    return []
  }
}

async function projectDirs(): Promise<string[]> {
  try {
    const entries = await readdir(sessionsDir(), { withFileTypes: true })
    return entries.filter((entry) => entry.isDirectory()).map((entry) => join(sessionsDir(), entry.name))
  } catch {
    return []
  }
}

async function summarize(path: string): Promise<SessionSummary | undefined> {
  let text: string
  try {
    text = await Bun.file(path).text()
  } catch {
    return undefined
  }

  let meta: SessionMeta | undefined
  let heading = ""
  let messages = 0

  for (const line of text.split("\n")) {
    if (!line) continue
    const record = parseRecord(line)
    if (!record) continue
    if (record.type === "meta") {
      meta = record.meta
      continue
    }
    if (record.type !== "event" || record.event.type !== "user_message") continue
    messages++
    if (!heading) heading = title(record.event.text)
  }

  if (!meta || messages === 0) return undefined

  return {
    id: meta.id,
    path,
    cwd: meta.cwd,
    title: heading || "(empty prompt)",
    messages,
    updatedAt: Bun.file(path).lastModified,
  }
}

export async function loadSession(path: string): Promise<LoadedSession | undefined> {
  let text: string
  try {
    text = await Bun.file(path).text()
  } catch {
    return undefined
  }

  let meta: SessionMeta | undefined
  const items: ConversationItem[] = []
  const events: AgentEvent[] = []

  for (const line of text.split("\n")) {
    if (!line) continue
    const record = parseRecord(line)
    if (!record) continue
    if (record.type === "meta") meta = record.meta
    else if (record.type === "item") items.push(record.item)
    else events.push(record.event)
  }

  return meta ? { meta, items, events } : undefined
}

export async function listSessions(cwd?: string): Promise<SessionSummary[]> {
  const dirs = cwd === undefined ? await projectDirs() : [projectSessionsDir(cwd)]
  const files = (await Promise.all(dirs.map(sessionFiles))).flat()
  const summaries = await Promise.all(files.map(summarize))
  return summaries.flatMap((summary) => (summary ? [summary] : [])).sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function latestSession(cwd: string): Promise<SessionSummary | undefined> {
  return (await listSessions(cwd))[0]
}

export async function findSession(id: string): Promise<SessionSummary | undefined> {
  const direct = join(projectSessionsDir(process.cwd()), `${id}.jsonl`)
  if (await Bun.file(direct).exists()) return summarize(direct)
  const all = await listSessions()
  return all.find((summary) => summary.id === id) ?? all.find((summary) => summary.id.startsWith(id))
}
