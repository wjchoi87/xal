import type { ChildProcess } from "node:child_process"

export function killProcessTree(process: ChildProcess): void {
  if (process.pid === undefined || process.exitCode !== null || process.signalCode !== null) return
  try {
    globalThis.process.kill(-process.pid, "SIGKILL")
  } catch {
    process.kill("SIGKILL")
  }
}
