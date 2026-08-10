import { randomUUID } from "node:crypto"
import { basename } from "node:path"
import { killTree, spawnCommand } from "./process"

const MAX_SNAPSHOT_BYTES = 2_000_000
const SNAPSHOT_TIMEOUT_MS = 10_000

interface ShellSnapshot {
  shell: string
  environment: Record<string, string>
  aliases: Record<string, string>
}

type ShellSnapshotState = { status: "pending" } | { status: "ready"; snapshot: ShellSnapshot } | { status: "failed" }

let state: ShellSnapshotState = { status: "pending" }
let initialization: Promise<void> | undefined

function aliasCapture(shell: string): string {
  const name = basename(shell)
  if (name === "bash") {
    return 'for name in "${!BASH_ALIASES[@]}"; do command printf \'%s\\0%s\\0\' "$name" "${BASH_ALIASES[$name]}"; done'
  }
  if (name === "zsh") {
    return 'for name in "${(@k)aliases}"; do command printf \'%s\\0%s\\0\' "$name" "${aliases[$name]}"; done'
  }
  return ":"
}

async function captureOutput(shell: string, marker: string): Promise<string> {
  const boundary = `command printf '\\0%s\\0' '${marker}'`
  const script = [boundary, "command env -0", boundary, aliasCapture(shell), boundary].join("; ")
  const proc = spawnCommand([shell, "-ilc", script], process.env, process.cwd())
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  let bytes = 0
  let exceededLimit = false
  let timedOut = false
  const collect =
    (target: Buffer[]) =>
    (chunk: Buffer): void => {
      if (exceededLimit) return
      bytes += chunk.length
      if (bytes > MAX_SNAPSHOT_BYTES) {
        exceededLimit = true
        killTree(proc)
        return
      }
      target.push(chunk)
    }
  proc.stdout.on("data", collect(stdout))
  proc.stderr.on("data", collect(stderr))
  const timeout = setTimeout(() => {
    timedOut = true
    killTree(proc)
  }, SNAPSHOT_TIMEOUT_MS)

  try {
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      proc.once("error", reject)
      proc.once("close", resolve)
    })
    if (exceededLimit) {
      throw new Error(`shell environment snapshot from ${shell} exceeded ${MAX_SNAPSHOT_BYTES} bytes`)
    }
    if (timedOut) {
      throw new Error(`shell environment snapshot from ${shell} timed out after ${SNAPSHOT_TIMEOUT_MS / 1_000} seconds`)
    }
    if (exitCode === 0) return Buffer.concat(stdout).toString("utf8")
    const detail = Buffer.concat(stderr).toString("utf8").trim()
    const reason = exitCode === null ? "was terminated by a signal" : `exited with code ${exitCode}`
    throw new Error(`shell environment snapshot from ${shell} ${reason}${detail ? `: ${detail}` : ""}`)
  } finally {
    clearTimeout(timeout)
  }
}

function fields(value: string): string[] {
  if (!value) return []
  if (!value.endsWith("\0")) throw new Error("shell environment snapshot contained an incomplete record")
  return value.slice(0, -1).split("\0")
}

function parseEnvironment(value: string): Record<string, string> {
  const entries: [string, string][] = []
  for (const record of fields(value)) {
    const separator = record.indexOf("=")
    if (separator <= 0) throw new Error("shell environment snapshot contained a malformed variable")
    entries.push([record.slice(0, separator), record.slice(separator + 1)])
  }
  return Object.fromEntries(entries)
}

function parseAliases(value: string): Record<string, string> {
  const records = fields(value)
  if (records.length % 2 !== 0) throw new Error("shell environment snapshot contained a malformed alias")
  const entries: [string, string][] = []
  for (let index = 0; index < records.length; index += 2) {
    const name = records[index]!
    if (!/^[A-Za-z0-9_!%+,.:@-]+$/.test(name)) continue
    entries.push([name, records[index + 1]!])
  }
  return Object.fromEntries(entries)
}

async function captureSnapshot(): Promise<ShellSnapshot> {
  const shell = process.env.SHELL?.trim() || "bash"
  const marker = randomUUID()
  const output = await captureOutput(shell, marker)
  const boundary = `\0${marker}\0`
  const first = output.indexOf(boundary)
  const second = output.indexOf(boundary, first + boundary.length)
  const third = output.indexOf(boundary, second + boundary.length)
  if (first < 0 || second < 0 || third < 0) {
    throw new Error(`shell environment snapshot from ${shell} was incomplete`)
  }
  return {
    shell,
    environment: parseEnvironment(output.slice(first + boundary.length, second)),
    aliases: parseAliases(output.slice(second + boundary.length, third)),
  }
}

function currentSnapshot(): ShellSnapshot | undefined {
  switch (state.status) {
    case "pending":
      throw new Error("shell environment snapshot is not initialized")
    case "ready":
      return state.snapshot
    case "failed":
      return undefined
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

export function initializeShellSnapshot(): Promise<void> {
  initialization ??= captureSnapshot().then(
    (captured) => {
      state = { status: "ready", snapshot: captured }
    },
    (error: unknown) => {
      state = { status: "failed" }
      throw error
    },
  )
  return initialization
}

export function snapshotEnvironment(): NodeJS.ProcessEnv {
  return currentSnapshot()?.environment ?? process.env
}

export function snapshotLaunch(command: string): string[] {
  const captured = currentSnapshot()
  if (!captured) return ["bash", "-c", command]
  const aliases = Object.entries(captured.aliases).map(([name, value]) => `alias -- ${shellQuote(`${name}=${value}`)}`)
  const script = [
    "shopt -s expand_aliases",
    ...aliases,
    "__tack_shell_command=$1",
    "shift",
    'eval "$__tack_shell_command"',
  ].join("\n")
  return ["bash", "-c", script, "bash", command]
}

export function expandSnapshotAliases(command: string): string {
  const captured = currentSnapshot()
  if (!captured) return command
  const expanded = new Set<string>()
  let result = command
  while (true) {
    const match = /^(\s*)([^\s;|&<>(){}]+)([\s\S]*)$/.exec(result)
    if (!match) return result
    const name = match[2]!
    const replacement = captured.aliases[name]
    if (replacement === undefined || expanded.has(name)) return result
    expanded.add(name)
    result = `${match[1]}${replacement}${match[3]}`
  }
}

export function shellSnapshotPrompt(): string {
  const captured = currentSnapshot()
  if (!captured) return ""
  return `Shell commands use environment state captured from ${basename(captured.shell)} startup, including ${Object.keys(captured.aliases).length} portable aliases.`
}
