import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import {
  finishAgentJob,
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
  if (!job.record) return job.transcript
  const record =
    job.record.status === "saved" ? `Task record: ${job.record.path}` : `Task record unavailable: ${job.record.message}`
  return job.transcript ? `${job.transcript}\n\n${record}` : record
}

async function saveTaskRecord(
  directory: string,
  job: BackgroundAgentJob,
  terminal: TaskTerminal,
  detail: string,
  worktree: ManagedWorktree | undefined,
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
      "",
      "## Assignment",
      job.task,
      "",
      ...workspace,
      ...report,
      "## Transcript",
      job.transcript || "(no transcript)",
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
  let finalDetail = detail
  try {
    const path = await saveTaskRecord(directory, job, terminal, detail, worktree)
    setAgentRecord(job, { status: "saved", path })
  } catch (error) {
    const message = describeError(error)
    setAgentRecord(job, { status: "failed", message })
    finalDetail = `${detail}; task record unavailable: ${message}`
  }
  finishAgentJob(job, terminal.outcome, finalDetail)
}
