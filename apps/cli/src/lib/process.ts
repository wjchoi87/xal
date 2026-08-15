import type { ChildProcess } from "node:child_process"

export function killProcessTree(process: ChildProcess, signal: NodeJS.Signals = "SIGKILL"): void {
  if (process.pid === undefined) return
  try {
    globalThis.process.kill(-process.pid, signal)
  } catch {
    if (process.exitCode !== null || process.signalCode !== null) return
    process.kill(signal)
  }
}
