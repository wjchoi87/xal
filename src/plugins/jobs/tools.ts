import { getJob, jobStatus, readJobOutput, stopJob, waitForJob, type BackgroundJob } from "../../background/jobs"
import { asNumber, asString } from "../../lib/json"
import type { Tool } from "../../tools/types"

const MAX_WAIT_S = 600

function jobOf(args: Record<string, unknown>): BackgroundJob {
  const id = asString(args.id)?.trim() ?? ""
  const job = getJob(id)
  if (!job) throw new Error(`no background job with id "${id}"`)
  return job
}

const idProperty = { type: "string", description: "Job id returned by bash background:true or sub_agent" }

function unreadOutput(job: BackgroundJob): string {
  const { text, dropped } = readJobOutput(job)
  if (!text) return ""
  return `${dropped ? "... older output dropped ...\n" : ""}${text.trimEnd()}`
}

export const jobOutputTool: Tool = {
  name: "job_output",
  description:
    "Read the output a background job (background bash command or sub-agent) has produced since the last read. Returns the new output followed by the job status. Pass wait to block until the job produces output or finishes instead of sleeping and polling.",
  parameters: {
    type: "object",
    properties: {
      id: idProperty,
      wait: {
        type: "number",
        description: `Maximum seconds to block until the job produces new output or finishes (default 0 returns immediately, max ${MAX_WAIT_S})`,
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
  async execute(args, signal) {
    const job = jobOf(args)
    const wait = Math.min(Math.max(asNumber(args.wait) ?? 0, 0), MAX_WAIT_S)
    await waitForJob(job, wait * 1000, signal)
    const unread = unreadOutput(job)
    return { output: `${unread || "(no new output)"}\n(${jobStatus(job)})` }
  },
}

export const jobKillTool: Tool = {
  name: "job_kill",
  description: "Stop a running background job (background bash command or sub-agent) and return any unread output.",
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
        ? `Stopped job ${job.id}.`
        : `Requested stop for job ${job.id}, but it has not finished yet — check it with job_output.`
    const unread = unreadOutput(job)
    return { output: unread ? `${headline}\nUnread output:\n${unread}` : headline }
  },
}
