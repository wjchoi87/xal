import { afterEach, expect, test } from "bun:test"
import { REDACTION_MARKER, replaceSecretValues } from "../secrets/redactor"
import {
  appendAgentTranscript,
  appendProcessOutput,
  collectAgentOutcome,
  createAgentJob,
  createProcessJob,
  finishAgentJob,
  finishProcessJob,
  getJob,
  readProcessOutput,
  stopJob,
  waitForAgentCompletion,
  waitForProcessOutput,
  type BackgroundAgentJob,
  type BackgroundProcessJob,
} from "./jobs"

const processJobs = new Set<BackgroundProcessJob>()
const agentJobs = new Set<BackgroundAgentJob>()

function processJob(prefix: string): BackgroundProcessJob {
  const job = createProcessJob(prefix, "background-jobs-test", () => {})
  processJobs.add(job)
  return job
}

function agentJob(prefix: string): BackgroundAgentJob {
  const job = createAgentJob(prefix, {
    ownerId: "background-jobs-test",
    task: prefix,
    stop: () => {},
    send: () => true,
  })
  agentJobs.add(job)
  return job
}

afterEach(() => {
  for (const job of processJobs) {
    finishProcessJob(job, "test cleanup")
    readProcessOutput(job)
  }
  for (const job of agentJobs) {
    finishAgentJob(job, { status: "interrupted" }, "test cleanup")
    if (!job.consumed) collectAgentOutcome(job)
  }
  processJobs.clear()
  agentJobs.clear()
  replaceSecretValues("background-jobs-test", [])
})

test("process output wakes a waiting reader", async () => {
  const job = processJob("test-process-output")
  const waiting = waitForProcessOutput(job, 60_000)

  expect(job.waiters).toHaveLength(1)
  appendProcessOutput(job, "ready")
  await waiting

  expect(job.waiters).toHaveLength(0)
  expect(readProcessOutput(job)).toEqual({ text: "ready", dropped: false })
})

test("process completion wakes a waiting reader", async () => {
  const job = processJob("test-process-finish")
  const waiting = waitForProcessOutput(job, 60_000)

  expect(job.waiters).toHaveLength(1)
  finishProcessJob(job, "finished")
  await waiting

  expect(job.waiters).toHaveLength(0)
  expect(job.done).toBe(true)
})

test("aborting a process wait removes and wakes its reader", async () => {
  const job = processJob("test-process-abort")
  const controller = new AbortController()
  const waiting = waitForProcessOutput(job, 60_000, controller.signal)

  expect(job.waiters).toHaveLength(1)
  controller.abort()
  await waiting

  expect(job.waiters).toHaveLength(0)
  expect(job.done).toBe(false)
})

test("agent completion and abort wake completion waiters", async () => {
  const completed = agentJob("test-agent-finish")
  let waitingForFinish = true
  const finishedWait = waitForAgentCompletion(completed, 60_000).then(() => {
    waitingForFinish = false
  })
  await Promise.resolve()
  expect(waitingForFinish).toBe(true)

  finishAgentJob(completed, { status: "completed", report: "done" }, "finished")
  await finishedWait
  expect(waitingForFinish).toBe(false)

  const aborted = agentJob("test-agent-abort")
  const controller = new AbortController()
  let waitingForAbort = true
  const abortedWait = waitForAgentCompletion(aborted, 60_000, controller.signal).then(() => {
    waitingForAbort = false
  })
  await Promise.resolve()
  expect(waitingForAbort).toBe(true)

  controller.abort()
  await abortedWait
  expect(waitingForAbort).toBe(false)
  expect(aborted.done).toBe(false)
})

test("redacts secrets split across process and agent output chunks", () => {
  const secret = "background-split-secret"
  replaceSecretValues("background-jobs-test", [secret])
  const process = processJob("test-process-redaction")
  const agent = agentJob("test-agent-redaction")

  appendProcessOutput(process, "process background-split-")
  appendProcessOutput(process, "secret complete")
  finishProcessJob(process, "finished")
  appendAgentTranscript(agent, "agent background-split-se")
  appendAgentTranscript(agent, "cret complete")
  finishAgentJob(agent, { status: "completed", report: "report" }, "finished")

  expect(readProcessOutput(process).text).toBe(`process ${REDACTION_MARKER} complete`)
  expect(process.history).toBe(`process ${REDACTION_MARKER} complete`)
  expect(agent.transcript).toBe(`agent ${REDACTION_MARKER} complete`)
})

test("returns each process output segment once including output appended before completion", () => {
  const job = processJob("test-process-unread")
  replaceSecretValues("background-jobs-test", ["unfinished-secret"])

  appendProcessOutput(job, "first")
  expect(readProcessOutput(job)).toEqual({ text: "first", dropped: false })
  appendProcessOutput(job, "second")
  appendProcessOutput(job, " and final unfinished-sec")
  finishProcessJob(job, "finished")

  expect(readProcessOutput(job)).toEqual({ text: "second and final unfinished-sec", dropped: false })
  expect(readProcessOutput(job)).toEqual({ text: "", dropped: false })
  expect(job.history).toBe("firstsecond and final unfinished-sec")
  expect(getJob(job.id)).toBeUndefined()
})

test("collects a completed agent report exactly once", () => {
  const job = agentJob("test-agent-report")
  finishAgentJob(job, { status: "completed", report: "final report" }, "finished")

  expect(collectAgentOutcome(job)).toEqual({ status: "completed", report: "final report" })
  expect(collectAgentOutcome(job)).toEqual({ status: "already_collected" })
  expect(getJob(job.id)).toBeUndefined()
})

test("suppresses agent delivery before invoking a racing stop callback", async () => {
  const holder: { job?: BackgroundAgentJob } = {}
  const job = createAgentJob("test-agent-stop-race", {
    ownerId: "background-jobs-test",
    task: "finish while cancellation starts",
    stop: () => {
      const current = holder.job
      if (!current) throw new Error("agent job was not initialized")
      finishAgentJob(current, { status: "completed", report: "too late" }, "completed during stop")
    },
    send: () => true,
  })
  holder.job = job
  agentJobs.add(job)

  await stopJob(job)

  expect(job.done).toBe(true)
  expect(job.consumed).toBe(true)
  expect(collectAgentOutcome(job)).toEqual({ status: "already_collected" })
})
