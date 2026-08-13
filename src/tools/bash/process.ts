import { spawn, type ChildProcessByStdio } from "node:child_process"
import type { Readable, Writable } from "node:stream"

export type CommandProcess = ChildProcessByStdio<null, Readable, Readable>

export type ShellProcess = ChildProcessByStdio<Writable, Readable, Readable>

export function spawnCommand(launch: string[], environment: NodeJS.ProcessEnv, cwd: string): CommandProcess {
  return spawn(launch[0]!, launch.slice(1), {
    cwd,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  })
}

export function spawnShellProcess(launch: string[], environment: NodeJS.ProcessEnv, cwd: string): ShellProcess {
  return spawn(launch[0]!, launch.slice(1), {
    cwd,
    env: environment,
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  })
}
