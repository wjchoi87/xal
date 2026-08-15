import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import {
  finishAgentJob,
  jobLogOf,
  sealAgentTranscript,
  setAgentRecord,
  type BackgroundAgentJob,
  type BackgroundAgentOutcome,
} from "../../background/jobs"
import type { ManagedWorktree } from "../../git/worktrees"
import { describeError } from "../../lib/error"
import { compactPath } from "../../lib/path"
import { redactText } from "../../secrets/redactor"

export interface TaskTerminal {
  outcome: BackgroundAgentOutcome
  detail: string
}

function taskDetail(detail: string, worktree: ManagedWorktree | undefined): string {
  return worktree ? `${detail} in ${worktree.branch} at ${compactPath(worktree.path)}` : detail
}

export function taskOutput(job: BackgroundAgentJob): string {
  const transcript = job.transcript.text()
  const saved = job.record
  if (!saved) return transcript
  const record =
    saved.status === "failed"
      ? `Task record unavailable: ${saved.message}`
      : saved.complete
        ? `Task record: ${saved.path}`
        : saved.reason === "capped"
          ? `Task record: ${saved.path} (transcript capped)`
          : `Task record: ${saved.path} (full transcript unavailable: ${saved.message})`
  return transcript ? `${transcript}\n\n${record}` : record
}

async function saveTaskRecord(
  directory: string,
  job: BackgroundAgentJob,
  terminal: TaskTerminal,
  detail: string,
  worktree: ManagedWorktree | undefined,
  transcriptNote: string,
): Promise<string> {
  const path = join(directory, `agent-${job.id.replace(/[^a-zA-Z0-9_-]/g, "_")}-${crypto.randomUUID()}.md`)
  const workspace = worktree
    ? ["## Workspace", `Path: ${worktree.path}`, `Branch: ${worktree.branch}`, `Base: ${worktree.baseCommit}`, ""]
    : []
  const report = terminal.outcome.status === "completed" ? ["## Final report", terminal.outcome.report, ""] : []
  const content = redactText(
    [
      "# Task agent record",
      "",
      `Agent: ${job.id}`,
      `Status: ${terminal.outcome.status}`,
      `Outcome: ${detail}`,
      transcriptNote,
      "",
      "## Assignment",
      job.task,
      "",
      ...workspace,
      ...report,
      "## Transcript",
      job.transcript.text() || "(no transcript)",
      "",
    ].join("\n"),
  )
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await writeFile(path, content, { encoding: "utf8", flag: "wx", mode: 0o600 })
  return path
}

export async function finishTask(
  job: BackgroundAgentJob,
  terminal: TaskTerminal,
  directory: string,
  worktree: ManagedWorktree | undefined,
): Promise<void> {
  const detail = taskDetail(terminal.detail, worktree)
  sealAgentTranscript(job)
  const log = jobLogOf(job)
  let transcript: { status: "complete" } | { status: "capped" } | { status: "unavailable"; message: string } = {
    status: "unavailable",
    message: "task transcript log was not created",
  }
  let transcriptNote = "Full transcript unavailable."
  if (log) {
    try {
      await log.close()
      transcript = { status: log.capped() ? "capped" : "complete" }
      transcriptNote = `Full transcript: ${log.path}${transcript.status === "capped" ? " (capped)" : ""}`
    } catch (error) {
      const message = describeError(error)
      transcript = { status: "unavailable", message }
      transcriptNote = `Full transcript unavailable: ${message}`
    }
  }
  let finalDetail = detail
  try {
    const path = await saveTaskRecord(directory, job, terminal, detail, worktree, transcriptNote)
    if (transcript.status === "complete") setAgentRecord(job, { status: "saved", path, complete: true })
    else if (transcript.status === "capped") {
      setAgentRecord(job, { status: "saved", path, complete: false, reason: "capped" })
    } else {
      setAgentRecord(job, {
        status: "saved",
        path,
        complete: false,
        reason: "unavailable",
        message: transcript.message,
      })
    }
  } catch (error) {
    const message = describeError(error)
    setAgentRecord(job, { status: "failed", message })
    finalDetail = `${detail}; task record unavailable: ${message}`
  }
  finishAgentJob(job, terminal.outcome, finalDetail)
}
