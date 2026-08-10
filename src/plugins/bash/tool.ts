import { asBoolean, asNumber, asString } from "../../lib/json"
import type { Tool } from "../../tools/types"
import { expandSnapshotAliases, snapshotEnvironment, snapshotLaunch } from "./environment"
import { startJob } from "./jobs"
import { killTree, spawnCommand } from "./process"
import { sandboxAvailable, sandboxLaunch } from "./sandbox"
import { splitCommand } from "./split"

const DEFAULT_TIMEOUT_S = 120
const MAX_TIMEOUT_S = 600
const READ_ONLY_COMMAND =
  /^(?:cat|find|grep|head|ls|pwd|rg|sleep|tail|wc)(?:\s|$)|^(?:git\s+(?:diff|log|show|status))(?:\s|$)|^(?:bun|cargo|npm|pnpm|yarn)\s+(?:run\s+)?test(?:\s|$)|^sed\s+(?!.*(?:\s-i|--in-place))|^git\s+branch\s+--show-current(?:\s|$)/

export function commandOf(args: Record<string, unknown>): string {
  return asString(args.command)?.trim() ?? ""
}

export function policyCommandOf(args: Record<string, unknown>): string {
  return expandSnapshotAliases(commandOf(args))
}

export function sandboxRequested(args: Record<string, unknown>): boolean {
  return sandboxAvailable() && asBoolean(args.sandbox) === true
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
      description: `Timeout in seconds before the command is killed (default ${DEFAULT_TIMEOUT_S}, max ${MAX_TIMEOUT_S})`,
    },
    background: {
      type: "boolean",
      description:
        "Run the command as a background job and return its job id immediately instead of waiting. The timeout does not apply. Read new output with job_output and stop the job with job_kill.",
    },
  }
  if (sandboxAvailable()) {
    properties.sandbox = {
      type: "boolean",
      description:
        "Run inside an OS sandbox that blocks network access and writes outside the workspace and temp directories. Sandboxed commands run without waiting for the user's approval.",
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
  const base =
    "Execute a bash command in the user's current working directory. Returns combined stdout and stderr followed by the exit code. Use it to run builds, tests, and shell operations; use grep and glob to search, and read, write, and edit for file contents."
  if (!sandboxAvailable()) return `${base} Each command requires the user's approval before it runs.`
  return `${base} Commands with sandbox:true run immediately inside an OS sandbox; other commands require the user's approval before they run.`
}

function guidance(): string {
  const base =
    "Use bash for shell work: builds, tests, git. Use the grep and glob tools to search instead of rg, find, or ls, and read, write, and edit for file contents instead of cat, sed, or heredocs. Prefer non-interactive commands; anything needing a TTY will hang. Start long-lived processes like dev servers and watchers with background:true, follow them with job_output (pass wait to block until new output or exit instead of sleeping between polls), and stop them with job_kill; never background quick commands."
  if (!sandboxAvailable()) return base
  return `${base} Prefer sandbox:true — it runs without approval but blocks network access and writes outside the workspace and temp directories. Use sandbox:false when a command needs network or writes elsewhere, and if a sandboxed command fails because of those limits, retry it with sandbox:false.`
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
    if (backgroundRequested(args)) return false
    const split = splitCommand(policyCommandOf(args))
    if (!split || split.redirected) return false
    return split.segments.every((segment) => READ_ONLY_COMMAND.test(segment))
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

    const sandboxed = sandboxRequested(args)
    const environment = { ...snapshotEnvironment(), PWD: ctx.cwd }
    const shellLaunch = snapshotLaunch(command)
    const launch = sandboxed ? sandboxLaunch(shellLaunch, ctx.cwd) : shellLaunch

    if (backgroundRequested(args)) {
      const job = startJob(command, spawnCommand(launch, environment, ctx.cwd), ctx.cwd)
      return {
        output: `Started background job ${job.id}${sandboxed ? " (sandboxed)" : ""}. Read its output with job_output and stop it with job_kill.`,
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
      else if (!sandboxed) footer = `(exit code ${exitCode})`
      else if (exitCode === 0) footer = "(exit code 0 · sandboxed)"
      else
        footer = `(exit code ${exitCode} · sandboxed — network and writes outside the workspace are blocked; retry with sandbox:false if the sandbox caused this)`
      return { output: trimmed ? `${trimmed}\n${footer}` : footer }
    } finally {
      clearTimeout(timeout)
      ctx.signal.removeEventListener("abort", onAbort)
    }
  },
}
