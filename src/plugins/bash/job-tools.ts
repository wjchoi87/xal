import { asNumber, asString } from "../../lib/json"
import type { Tool } from "../../tools/types"
import { getJob, jobStatus, killJob, readJobOutput, waitForJob, type BashJob } from "./jobs"

const MAX_WAIT_S = 600

function jobOf(args: Record<string, unknown>): BashJob {
  const id = asString(args.id)?.trim() ?? ""
  const job = getJob(id)
  if (!job) throw new Error(`no background job with id "${id}"`)
  return job
}

const idProperty = { type: "string", description: "Background job id returned by bash" }

function unreadOutput(job: BashJob): string {
  const { text, dropped } = readJobOutput(job)
  if (!text) return ""
  return `${dropped ? "... older output dropped ...\n" : ""}${text.trimEnd()}`
}

export const bashOutputTool: Tool = {
  name: "bash_output",
  description:
    "Read the output a background bash job has produced since the last read. Returns the new output followed by the job status. Pass wait to block until the job produces output or exits instead of sleeping and polling.",
  parameters: {
    type: "object",
    properties: {
      id: idProperty,
      wait: {
        type: "number",
        description: `Maximum seconds to block until the job produces new output or exits (default 0 returns immediately, max ${MAX_WAIT_S})`,
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

export const bashKillTool: Tool = {
  name: "bash_kill",
  description: "Kill a running background bash job and return any unread output.",
  parameters: {
    type: "object",
    properties: { id: idProperty },
    required: ["id"],
    additionalProperties: false,
  },
  title(args) {
    return `kill ${asString(args.id) ?? ""}`
  },
  async execute(args) {
    const job = jobOf(args)
    const alreadyExited = job.status === "exited"
    if (!alreadyExited) await killJob(job)
    const headline = alreadyExited
      ? `Job ${job.id} had already exited (${jobStatus(job)}).`
      : job.status === "exited"
        ? `Killed job ${job.id}.`
        : `Sent SIGKILL to job ${job.id}, but it has not exited yet — check it with bash_output.`
    const unread = unreadOutput(job)
    return { output: unread ? `${headline}\nUnread output:\n${unread}` : headline }
  },
}
