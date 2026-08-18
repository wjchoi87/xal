import { afterEach, expect, test } from "bun:test"
import { formatBackgroundResult } from "../agent/session/async"
import {
  appendAgentTranscript,
  createAgentJob,
  finishAgentJob,
  startAgentJob,
  suppressDelivery,
  type BackgroundAgentJob,
} from "./jobs"
import { collectAgentOutput } from "./tools"

const jobs = new Set<BackgroundAgentJob>()

function agentJob(prefix: string): BackgroundAgentJob {
  const job = createAgentJob(prefix, {
    ownerId: "background-tools-test",
    task: prefix,
    timeoutMs: 60_000,
    maxTurns: 24,
    stop: () => {},
    send: () => true,
  })
  jobs.add(job)
  return job
}

afterEach(() => {
  for (const job of jobs) {
    finishAgentJob(job, { status: "interrupted" }, "test cleanup")
    suppressDelivery(job)
  }
  jobs.clear()
})

test("returns before the deadline with an actionable supervision checkpoint", async () => {
  const job = agentJob("test-agent-output-supervision-checkpoint")
  startAgentJob(job)
  job.deadlineAt = Date.now() + 10_000

  const output = await collectAgentOutput(job, 60, new AbortController().signal)

  expect(output).toContain("turn cycles 0/24")
  expect(output).toContain("Supervision checkpoint reached before the task deadline")
  expect(output).toContain("job_extend")
  expect(job.delivery).toBe("none")
})

test("labels a timed-out transcript tail as incomplete", async () => {
  const job = agentJob("test-incomplete-agent-transcript")
  appendAgentTranscript(job, "review progress and an unfinished report")
  finishAgentJob(job, { status: "timed_out" }, "timed out after 1m")

  const output = await collectAgentOutput(job, 0, new AbortController().signal)

  expect(output).toContain("Incomplete transcript tail:\nreview progress and an unfinished report")
})

test("includes incomplete work in automatic timeout delivery", () => {
  const job = agentJob("test-automatic-timeout-transcript")
  appendAgentTranscript(job, `old marker ${"a".repeat(4_000)} latest automatic marker`)
  finishAgentJob(job, { status: "timed_out" }, "timed out after 1m")

  const result = formatBackgroundResult(job)

  expect(result.kind).toBe("agent")
  expect(result.output).toContain("Incomplete transcript tail (earlier output omitted):")
  expect(result.output).not.toContain("old marker")
  expect(result.output).toContain("latest automatic marker")
})

test("bounds an incomplete transcript to its latest output", async () => {
  const job = agentJob("test-bounded-incomplete-agent-transcript")
  appendAgentTranscript(job, `old marker ${"a".repeat(4_000)} latest marker`)
  finishAgentJob(job, { status: "timed_out" }, "timed out after 1m")

  const output = await collectAgentOutput(job, 0, new AbortController().signal)

  expect(output).toContain("Incomplete transcript tail (earlier output omitted):")
  expect(output).not.toContain("old marker")
  expect(output).toContain("latest marker")
})
