import { randomUUID } from "node:crypto"
import { statSync } from "node:fs"
import { basename, isAbsolute } from "node:path"
import { appInfo } from "../../app-info"
import { killProcessTree } from "../../lib/process"
import { spawnCommand, spawnShellProcess, type ShellProcess } from "./process"
import { sandboxLaunch, sandboxProcessEnvironment, type SandboxAccess } from "./sandbox"

const SUPPORTED_SHELLS = new Set(["sh", "bash", "dash", "ksh", "mksh", "zsh"])

export interface ShellSelection {
  executable: string
  label: string
  diagnostic?: string
}

let selected: ShellSelection | undefined

function shellProblem(path: string, label: string): string | undefined {
  if (!isAbsolute(path)) return "must be an absolute path"
  if (!SUPPORTED_SHELLS.has(label)) return "names an unsupported shell"
  let stats
  try {
    stats = statSync(path)
  } catch {
    return "does not exist"
  }
  if (!stats.isFile()) return "is not a regular file"
  if ((stats.mode & 0o111) === 0) return "is not executable"
  return undefined
}

export function selectShell(): ShellSelection {
  if (selected) return selected
  const configured = process.env.SHELL?.trim()
  if (!configured) {
    selected = { executable: "/bin/sh", label: "sh" }
    return selected
  }
  const label = basename(configured)
  const problem = shellProblem(configured, label)
  selected = problem
    ? {
        executable: "/bin/sh",
        label: "sh",
        diagnostic: `$SHELL ${JSON.stringify(configured)} ${problem}; using /bin/sh (supported shells: sh, bash, dash, ksh, mksh, zsh)`,
      }
    : { executable: configured, label }
  return selected
}

export function shellPrompt(): string {
  const shell = selectShell()
  const note = shell.diagnostic ? ` (${shell.diagnostic})` : ""
  return `Shell commands run inside a persistent ${shell.label} session${note}: cd, exported variables, and aliases or functions defined by earlier commands stay in effect for later ones. The session starts without interactive rc files, so the user's interactive aliases are not loaded unless a command sources them.`
}

export function shellLaunch(args: string[], cwd: string, sandbox: SandboxAccess | undefined): string[] {
  const launch = [selectShell().executable, ...args]
  return sandbox ? sandboxLaunch(launch, cwd, sandbox) : launch
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

export interface ShellExecution {
  done: Promise<ShellTermination>
  kill(): void
}

export type ShellTermination = { status: "exited"; exitCode: number } | { status: "signaled"; signal?: string }

interface ActiveRun {
  feed(text: string): void
  close(code: number | null, signal: NodeJS.Signals | null): void
  fail(error: Error): void
}

interface ShellEntry {
  proc: ShellProcess
  workspace: string
  dead: boolean
  active: ActiveRun | undefined
}

const pools = new Map<string, Map<string, ShellEntry>>()
let exitHookRegistered = false

function registerExitHook(): void {
  if (exitHookRegistered) return
  exitHookRegistered = true
  process.on("exit", () => {
    for (const pool of pools.values()) {
      for (const entry of pool.values()) killProcessTree(entry.proc)
    }
  })
}

export function disposeShellSession(sessionId: string): void {
  const pool = pools.get(sessionId)
  if (!pool) return
  pools.delete(sessionId)
  for (const entry of pool.values()) killProcessTree(entry.proc)
}

function spawnEntry(cwd: string, sandbox: SandboxAccess | undefined): ShellEntry {
  const proc = spawnShellProcess(shellLaunch(["-s"], cwd, sandbox), processEnvironment(cwd, sandbox), cwd)
  const entry: ShellEntry = { proc, workspace: cwd, dead: false, active: undefined }
  const feed = (chunk: Buffer): void => entry.active?.feed(chunk.toString())
  proc.stdout.on("data", feed)
  proc.stderr.on("data", feed)
  proc.stdin.on("error", (error) => {
    entry.dead = true
    entry.active?.fail(error)
  })
  proc.once("error", (error) => {
    entry.dead = true
    entry.active?.fail(error)
  })
  proc.once("close", (code, signal) => {
    entry.dead = true
    entry.active?.close(code, signal)
  })
  return entry
}

function processEnvironment(cwd: string, sandbox: SandboxAccess | undefined): NodeJS.ProcessEnv {
  const environment = { ...process.env, PWD: cwd }
  return sandbox ? sandboxProcessEnvironment(environment) : environment
}

function runPersistent(
  entry: ShellEntry,
  command: string,
  onOutput: (text: string) => void,
): Promise<ShellTermination> {
  return new Promise((resolve, reject) => {
    const marker = `__${appInfo.name}_${randomUUID()}__`
    const needle = `\n${marker}:`
    const holdback = needle.length + 8
    let pending = ""
    let emitted = 0
    let settled = false

    const emit = (limit: number): void => {
      if (limit <= emitted) return
      onOutput(pending.slice(emitted, limit))
      emitted = limit
    }
    const settle = (finish: () => void): void => {
      if (settled) return
      settled = true
      entry.active = undefined
      finish()
    }
    entry.active = {
      feed(text) {
        pending += text
        const found = pending.indexOf(needle)
        if (found < 0) {
          emit(pending.length - holdback)
          return
        }
        const lineEnd = pending.indexOf("\n", found + needle.length)
        if (lineEnd < 0) return
        emit(found)
        const status = Number.parseInt(pending.slice(found + needle.length, lineEnd), 10)
        settle(() => resolve(Number.isNaN(status) ? { status: "signaled" } : { status: "exited", exitCode: status }))
      },
      close(code, signal) {
        emit(pending.length)
        settle(() =>
          resolve(
            code === null
              ? { status: "signaled", ...(signal === null ? {} : { signal }) }
              : { status: "exited", exitCode: code },
          ),
        )
      },
      fail(error) {
        settle(() => reject(error))
      },
    }
    entry.proc.stdin.write(
      `{ eval ${shellQuote(command)}; } </dev/null 2>&1\nprintf '\\n%s:%s\\n' ${shellQuote(marker)} "$?"\n`,
    )
  })
}

function runIsolated(
  command: string,
  cwd: string,
  sandbox: SandboxAccess | undefined,
  onOutput: (text: string) => void,
): ShellExecution {
  const proc = spawnCommand(shellLaunch(["-c", command], cwd, sandbox), processEnvironment(cwd, sandbox), cwd)
  const collect = (chunk: Buffer): void => onOutput(chunk.toString())
  proc.stdout.on("data", collect)
  proc.stderr.on("data", collect)
  const done = new Promise<ShellTermination>((resolve, reject) => {
    proc.once("error", reject)
    proc.once("close", (code, signal) => {
      resolve(
        code === null
          ? { status: "signaled", ...(signal === null ? {} : { signal }) }
          : { status: "exited", exitCode: code },
      )
    })
  })
  return { done, kill: () => killProcessTree(proc) }
}

export function executeShellCommand(
  sessionId: string,
  command: string,
  cwd: string,
  sandbox: SandboxAccess | undefined,
  onOutput: (text: string) => void,
): ShellExecution {
  registerExitHook()
  let pool = pools.get(sessionId)
  if (!pool) {
    pool = new Map()
    pools.set(sessionId, pool)
  }
  const key = sandbox ?? "plain"
  let entry = pool.get(key)
  if (entry?.dead) {
    pool.delete(key)
    entry = undefined
  }
  if (entry?.active) return runIsolated(command, cwd, sandbox, onOutput)
  if (entry && entry.workspace !== cwd) {
    killProcessTree(entry.proc)
    pool.delete(key)
    entry = undefined
  }
  if (!entry) {
    entry = spawnEntry(cwd, sandbox)
    pool.set(key, entry)
  }
  const target = entry
  return { done: runPersistent(target, command, onOutput), kill: () => killProcessTree(target.proc) }
}
