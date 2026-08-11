import { spawn, type ChildProcessByStdio } from "node:child_process"
import type { Readable } from "node:stream"

export type CommandProcess = ChildProcessByStdio<null, Readable, Readable>

export function spawnCommand(launch: string[], environment: NodeJS.ProcessEnv, cwd: string): CommandProcess {
  return spawn(launch[0]!, launch.slice(1), {
    cwd,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  })
}
