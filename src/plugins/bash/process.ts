import { spawn, type ChildProcess, type ChildProcessByStdio } from "node:child_process"
import type { Readable } from "node:stream"

export type CommandProcess = ChildProcessByStdio<null, Readable, Readable>

export function spawnCommand(launch: string[], environment: NodeJS.ProcessEnv): CommandProcess {
  return spawn(launch[0]!, launch.slice(1), {
    cwd: process.cwd(),
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  })
}

export function killTree(proc: ChildProcess): void {
  if (proc.pid === undefined || proc.exitCode !== null || proc.signalCode !== null) return
  try {
    process.kill(-proc.pid, "SIGKILL")
  } catch {
    proc.kill("SIGKILL")
  }
}
