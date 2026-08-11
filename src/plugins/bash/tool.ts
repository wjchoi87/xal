import { asBoolean, asNumber, asString } from "../../lib/json"
import type { Tool } from "../../tools/types"
import { expandSnapshotAliases, snapshotEnvironment, snapshotLaunch } from "./environment"
import { startJob } from "./jobs"
import { killTree, spawnCommand } from "./process"
import { sandboxAvailable, sandboxLaunch, type SandboxAccess } from "./sandbox"
import { splitCommand } from "./split"

const DEFAULT_TIMEOUT_S = 120
const MAX_TIMEOUT_S = 600

export function commandOf(args: Record<string, unknown>): string {
  return asString(args.command)?.trim() ?? ""
}

export function policyCommandOf(args: Record<string, unknown>): string {
  return expandSnapshotAliases(commandOf(args))
}

export function sandboxAccessOf(args: Record<string, unknown>): SandboxAccess | undefined {
  if (!sandboxAvailable()) return undefined
  const access = asString(args.sandbox)
  if (access === "read" || access === "workspace") return access
  return undefined
}

export function sandboxRequested(args: Record<string, unknown>): boolean {
  return sandboxAccessOf(args) !== undefined
}

export function backgroundRequested(args: Record<string, unknown>): boolean {
  return asBoolean(args.background) === true
}

function timeoutSecondsOf(args: Record<string, unknown>): number {
  const requested = asNumber(args.timeout) ?? DEFAULT_TIMEOUT_S
  return Math.min(Math.max(Math.round(requested), 1), MAX_TIMEOUT_S)
}

function parameters(): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    command: {
      type: "string",
      description: "The bash command to execute",
    },
    timeout: {
      type: "number",
      description: `Seconds before the command is killed. Defaults to ${DEFAULT_TIMEOUT_S}; maximum ${MAX_TIMEOUT_S}`,
    },
    background: {
      type: "boolean",
      description:
        "True runs the command as a background job and returns its job id immediately; the timeout does not apply. Read new output with job_output and stop the job with job_kill",
    },
  }
  if (sandboxAvailable()) {
    properties.sandbox = {
      type: "string",
      enum: ["read", "workspace"],
      description:
        'Use "read" to enforce no filesystem state changes, or "workspace" to allow writes only in the workspace and temporary directories. Both block network access and run without approval',
    }
  }
  return {
    type: "object",
    properties,
    required: ["command"],
    additionalProperties: false,
  }
}

function description(): string {
  const base = `Execute a bash command in the user's current working directory. Returns combined stdout and stderr followed by the exit code. Commands run without a TTY and are killed after ${DEFAULT_TIMEOUT_S} seconds unless timeout says otherwise.`
  if (!sandboxAvailable()) return `${base} Each command requires the user's approval before it runs.`
  return `${base} Sandboxed commands run immediately with OS-enforced filesystem and network restrictions; other commands require the user's approval before they run.`
}

function guidance(): string {
  const base =
    "Use bash for shell work: builds, tests, git. Use the grep and glob tools to search instead of rg, find, or ls, and read, write, and edit for file contents instead of cat, sed, echo, or heredocs. Quote paths that contain spaces. Issue independent commands as parallel calls; chain dependent commands with && so a failure stops the sequence. Prefer non-interactive flags; anything that waits for input hangs until the timeout kills it. Start long-lived processes like dev servers and watchers with background:true, follow them with job_output (pass wait to block until new output or exit instead of sleeping between polls), and stop them with job_kill; never background quick commands. Only commit, amend, or push with git when the user asks for it."
  if (!sandboxAvailable()) return base
  return `${base} Use sandbox:"read" for inspection commands because the OS blocks filesystem state changes. Use sandbox:"workspace" for builds and commands that may write only in the workspace or temporary directories. Omit sandbox when the command needs network or writes elsewhere.`
}

export const bashTool: Tool = {
  name: "bash",
  description: description(),
  parameters: parameters(),
  prompt: guidance(),
  title(args) {
    return asString(args.command) ?? ""
  },
  readOnly(args) {
    return !backgroundRequested(args) && sandboxAccessOf(args) === "read"
  },
  undo(args) {
    if (backgroundRequested(args)) return { type: "invalidate" }
    return sandboxAccessOf(args) === "read" ? { type: "none" } : { type: "workspace" }
  },
  sandboxed(args) {
    return sandboxRequested(args)
  },
  permission(args) {
    const command = policyCommandOf(args)
    const split = splitCommand(command)
    if (!split || split.segments.length > 1) return { subject: command }
    const words = split.segments[0]!.split(/\s+/)
    if (words.length < 2) return { subject: command, suggestion: `bash(${command})` }
    return { subject: command, suggestion: `bash(${words[0]} ${words[1]}*)` }
  },
  async execute(args, ctx) {
    const command = commandOf(args)
    if (!command) return { output: "(no command provided)" }

    const sandbox = sandboxAccessOf(args)
    const environment = { ...snapshotEnvironment(), PWD: ctx.cwd }
    const shellLaunch = snapshotLaunch(command)
    const launch = sandbox ? sandboxLaunch(shellLaunch, ctx.cwd, sandbox) : shellLaunch

    if (backgroundRequested(args)) {
      const job = startJob(command, spawnCommand(launch, environment, ctx.cwd), ctx.cwd)
      return {
        output: `Started background job ${job.id}${sandbox ? ` (${sandbox} sandbox)` : ""}. Read its output with job_output and stop it with job_kill.`,
      }
    }

    const timeoutSeconds = timeoutSecondsOf(args)
    const proc = spawnCommand(launch, environment, ctx.cwd)

    let output = ""
    const collect = (chunk: Buffer): void => {
      const text = chunk.toString()
      output += text
      ctx.update(text)
    }
    proc.stdout.on("data", collect)
    proc.stderr.on("data", collect)

    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      killTree(proc)
    }, timeoutSeconds * 1000)
    const onAbort = (): void => killTree(proc)
    ctx.signal.addEventListener("abort", onAbort)

    try {
      const exitCode = await new Promise<number | null>((resolve, reject) => {
        proc.once("error", reject)
        proc.once("close", (code) => resolve(code))
      })
      const trimmed = output.trimEnd()
      let footer: string
      if (timedOut) footer = `(timed out after ${timeoutSeconds}s and was killed)`
      else if (ctx.signal.aborted) footer = "(interrupted by user)"
      else if (exitCode === null) footer = "(terminated by signal)"
      else if (!sandbox) footer = `(exit code ${exitCode})`
      else if (exitCode === 0) footer = `(exit code 0 · ${sandbox} sandbox)`
      else
        footer = `(${
          sandbox === "read"
            ? `exit code ${exitCode} · read sandbox — network and filesystem state changes are blocked`
            : `exit code ${exitCode} · workspace sandbox — network and writes outside the workspace and temporary directories are blocked`
        })`
      return { output: trimmed ? `${trimmed}\n${footer}` : footer }
    } finally {
      clearTimeout(timeout)
      ctx.signal.removeEventListener("abort", onAbort)
    }
  },
}
