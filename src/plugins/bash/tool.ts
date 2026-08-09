import { asBoolean, asNumber, asString } from "../../lib/json"
import type { Tool } from "../../tools/types"
import { startJob } from "./jobs"
import { killTree, spawnCommand } from "./process"
import { sandboxAvailable, sandboxLaunch } from "./sandbox"

const DEFAULT_TIMEOUT_S = 120
const MAX_TIMEOUT_S = 600
const READ_ONLY_COMMAND =
  /^(?:cat|find|grep|head|ls|pwd|rg|tail|wc)(?:\s|$)|^(?:git\s+(?:diff|log|show|status))(?:\s|$)|^(?:bun|cargo|npm|pnpm|yarn)\s+(?:run\s+)?test(?:\s|$)|^sed\s+(?!.*(?:\s-i|--in-place))|^git\s+branch\s+--show-current(?:\s|$)/

export const COMPOUND_COMMAND = /[;|&\n`<>(){}]/

export function commandOf(args: Record<string, unknown>): string {
  return asString(args.command)?.trim() ?? ""
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
        "Run the command as a background job and return its job id immediately instead of waiting. The timeout does not apply. Read new output with bash_output and stop the job with bash_kill.",
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
    "Use bash for shell work: builds, tests, git. Use the grep and glob tools to search instead of rg, find, or ls, and read, write, and edit for file contents instead of cat, sed, or heredocs. Prefer non-interactive commands; anything needing a TTY will hang. Start long-lived processes like dev servers and watchers with background:true, follow them with bash_output (pass wait to block until new output or exit instead of sleeping between polls), and stop them with bash_kill; never background quick commands."
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
    const command = commandOf(args)
    if (COMPOUND_COMMAND.test(command)) return false
    return READ_ONLY_COMMAND.test(command)
  },
  sandboxed(args) {
    return sandboxRequested(args)
  },
  permission(args) {
    const command = commandOf(args)
    if (COMPOUND_COMMAND.test(command)) return { subject: command }
    const words = command.split(/\s+/)
    if (words.length < 2) return { subject: command, suggestion: `bash(${command})` }
    return { subject: command, suggestion: `bash(${words[0]} ${words[1]}*)` }
  },
  async execute(args, signal, update) {
    const command = commandOf(args)
    if (!command) return { output: "(no command provided)" }

    const sandboxed = sandboxRequested(args)
    const launch = sandboxed ? sandboxLaunch(command, process.cwd()) : ["bash", "-c", command]

    if (backgroundRequested(args)) {
      const job = startJob(command, spawnCommand(launch))
      return {
        output: `Started background job ${job.id}${sandboxed ? " (sandboxed)" : ""}. Read its output with bash_output and stop it with bash_kill.`,
      }
    }

    const timeoutSeconds = timeoutSecondsOf(args)
    const proc = spawnCommand(launch)

    let output = ""
    const collect = (chunk: Buffer): void => {
      const text = chunk.toString()
      output += text
      update?.(text)
    }
    proc.stdout.on("data", collect)
    proc.stderr.on("data", collect)

    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      killTree(proc)
    }, timeoutSeconds * 1000)
    const onAbort = (): void => killTree(proc)
    signal?.addEventListener("abort", onAbort)

    try {
      const exitCode = await new Promise<number | null>((resolve, reject) => {
        proc.once("error", reject)
        proc.once("close", (code) => resolve(code))
      })
      const trimmed = output.trimEnd()
      let footer: string
      if (timedOut) footer = `(timed out after ${timeoutSeconds}s and was killed)`
      else if (signal?.aborted) footer = "(interrupted by user)"
      else if (exitCode === null) footer = "(terminated by signal)"
      else if (!sandboxed) footer = `(exit code ${exitCode})`
      else if (exitCode === 0) footer = "(exit code 0 · sandboxed)"
      else
        footer = `(exit code ${exitCode} · sandboxed — network and writes outside the workspace are blocked; retry with sandbox:false if the sandbox caused this)`
      return { output: trimmed ? `${trimmed}\n${footer}` : footer }
    } finally {
      clearTimeout(timeout)
      signal?.removeEventListener("abort", onAbort)
    }
  },
}
