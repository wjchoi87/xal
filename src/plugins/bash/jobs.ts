import {
  appendProcessOutput,
  createProcessJob,
  finishProcessJob,
  stopJob,
  type BackgroundProcessJob,
} from "../../background/jobs"
import { registerBackgroundTask } from "../../background/registry"
import { killTree, type CommandProcess } from "./process"

const runningProcs = new Set<CommandProcess>()
let exitHookRegistered = false

function registerExitHook(): void {
  if (exitHookRegistered) return
  exitHookRegistered = true
  process.on("exit", () => {
    for (const proc of runningProcs) killTree(proc)
  })
}

export function startJob(command: string, proc: CommandProcess, cwd: string): BackgroundProcessJob {
  registerExitHook()
  runningProcs.add(proc)
  let exitCode: number | null = null
  const job = createProcessJob("bash", () => killTree(proc))
  const collect = (chunk: Buffer): void => {
    appendProcessOutput(job, chunk.toString())
  }
  proc.stdout.on("data", collect)
  proc.stderr.on("data", collect)
  proc.once("error", (error) => {
    runningProcs.delete(proc)
    appendProcessOutput(job, `${job.history ? "\n" : ""}failed to launch: ${error.message}`)
    finishProcessJob(job, "failed to launch")
  })
  proc.once("close", (code) => {
    runningProcs.delete(proc)
    exitCode = code
    finishProcessJob(job, code === null ? "terminated by signal" : `exited with code ${code}`)
  })
  registerBackgroundTask({
    kind: "process",
    id: job.id,
    title: command,
    startedAt: Date.now(),
    cwd,
    state: () => {
      if (!job.done) return { running: true }
      if (exitCode !== null) return { running: false, ok: exitCode === 0, detail: `exit ${exitCode}` }
      return { running: false, ok: false, detail: "killed" }
    },
    output: () => job.history,
    stop: () => stopJob(job),
  })
  return job
}
