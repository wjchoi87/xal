import {
  collectAgentOutcome,
  getJob,
  jobStatus,
  readProcessOutput,
  stopJob,
  waitForAgentCompletion,
  waitForProcessOutput,
  type BackgroundAgentJob,
  type BackgroundJob,
  type BackgroundProcessJob,
} from "./jobs"
import { asNumber, asString } from "../lib/json"
import type { Tool } from "../tools/types"

const MAX_WAIT_S = 600

function jobOf(args: Record<string, unknown>): BackgroundJob {
  const id = asString(args.id)?.trim() ?? ""
  const job = getJob(id)
  if (!job) throw new Error(`no background job with id "${id}"`)
  return job
}

const idProperty = { type: "string", description: "Job id returned by bash background mode or sub_agent" }

function waitSeconds(args: Record<string, unknown>): number {
  return Math.min(Math.max(asNumber(args.wait) ?? 0, 0), MAX_WAIT_S)
}

function unreadProcessOutput(job: BackgroundProcessJob): string {
  const { text, dropped } = readProcessOutput(job)
  if (!text) return ""
  return `${dropped ? "... older output dropped ...\n" : ""}${text.trimEnd()}`
}

async function processOutput(job: BackgroundProcessJob, wait: number, signal: AbortSignal): Promise<string> {
  await waitForProcessOutput(job, wait * 1_000, signal)
  const unread = unreadProcessOutput(job)
  return `${unread || "(no new output)"}\n(${jobStatus(job)})`
}

async function agentOutput(job: BackgroundAgentJob, wait: number, signal: AbortSignal): Promise<string> {
  await waitForAgentCompletion(job, wait * 1_000, signal)
  if (!job.done) return `(still running: ${job.activity})`

  const outcome = collectAgentOutcome(job)
  switch (outcome.status) {
    case "completed":
      return `${outcome.report}\n(${jobStatus(job)})`
    case "failed":
    case "interrupted":
      return `(${jobStatus(job)})`
    case "already_collected":
      return `(report already collected; ${jobStatus(job)})`
  }
}

export const jobOutputTool: Tool = {
  name: "job_output",
  description:
    "Collect a background job. For a process, returns new output and waits for new output or exit. For a sub-agent, waits for completion and returns its final report exactly once without exposing its internal transcript. Pass wait to block instead of polling.",
  parameters: {
    type: "object",
    properties: {
      id: idProperty,
      wait: {
        type: "number",
        description: `Maximum seconds to block. Defaults to 0; maximum ${MAX_WAIT_S}`,
      },
    },
    required: ["id"],
    additionalProperties: false,
  },
  title(args) {
    return `${asString(args.id) ?? ""} output`
  },
  readOnly() {
    return true
  },
  async execute(args, ctx) {
    const job = jobOf(args)
    const wait = waitSeconds(args)
    switch (job.kind) {
      case "process":
        return { output: await processOutput(job, wait, ctx.signal) }
      case "agent":
        return { output: await agentOutput(job, wait, ctx.signal) }
    }
  },
}

export const jobKillTool: Tool = {
  name: "job_kill",
  description:
    "Stop a running background process or sub-agent. Process output not yet collected is returned; sub-agent transcripts remain available only in the background-task viewer.",
  parameters: {
    type: "object",
    properties: { id: idProperty },
    required: ["id"],
    additionalProperties: false,
  },
  title(args) {
    return `kill ${asString(args.id) ?? ""}`
  },
  readOnly() {
    return true
  },
  async execute(args) {
    const job = jobOf(args)
    const alreadyDone = job.done
    if (!alreadyDone) await stopJob(job)
    const headline = alreadyDone
      ? `Job ${job.id} had already finished (${jobStatus(job)}).`
      : job.done
        ? `Job ${job.id} finished after stop was requested (${jobStatus(job)}).`
        : `Requested stop for job ${job.id}, but it has not finished yet — check it with job_output.`
    if (job.kind === "agent") {
      const collection =
        job.outcome?.status === "completed" && !job.consumed ? " Collect its report with job_output." : ""
      if (job.done && job.outcome?.status !== "completed" && !job.consumed) collectAgentOutcome(job)
      return { output: `${headline}${collection}` }
    }
    const unread = unreadProcessOutput(job)
    return { output: unread ? `${headline}\nUnread output:\n${unread}` : headline }
  },
}
