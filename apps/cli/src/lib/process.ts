import type { ChildProcess } from "node:child_process"

export function isStandalone(): boolean {
  return Bun.main.startsWith("/$bunfs/")
}

export function selfCommand(args: string[]): string[] {
  if (isStandalone()) return [process.execPath, ...args]
  return [process.execPath, Bun.main, ...args]
}

export function killProcessTree(process: ChildProcess, signal: NodeJS.Signals = "SIGKILL"): void {
  if (process.pid === undefined) return
  try {
    globalThis.process.kill(-process.pid, signal)
  } catch {
    if (process.exitCode !== null || process.signalCode !== null) return
    process.kill(signal)
  }
}
