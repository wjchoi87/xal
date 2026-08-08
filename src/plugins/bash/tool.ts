import { asString } from "../../lib/json"
import type { Tool } from "../../tools/types"

const TIMEOUT_MS = 120_000
const READ_ONLY_COMMAND =
  /^(?:cat|find|grep|head|ls|pwd|rg|tail|wc)(?:\s|$)|^(?:git\s+(?:diff|log|show|status))(?:\s|$)|^(?:bun|cargo|npm|pnpm|yarn)\s+(?:run\s+)?test(?:\s|$)|^sed\s+(?!.*(?:\s-i|--in-place))|^git\s+branch\s+--show-current(?:\s|$)/

export const COMPOUND_COMMAND = /[;|&\n`<>(){}]/

export function commandOf(args: Record<string, unknown>): string {
  return asString(args.command)?.trim() ?? ""
}

export const bashTool: Tool = {
  name: "bash",
  description:
    "Execute a bash command in the user's current working directory. Returns combined stdout and stderr followed by the exit code. Use it to run builds, tests, and shell operations; use grep and glob to search, and read, write, and edit for file contents. Each command requires the user's approval before it runs.",
  parameters: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The bash command to execute",
      },
    },
    required: ["command"],
    additionalProperties: false,
  },
  prompt:
    "Use bash for shell work: builds, tests, git. Use the grep and glob tools to search instead of rg, find, or ls, and read, write, and edit for file contents instead of cat, sed, or heredocs. Prefer non-interactive commands; anything needing a TTY will hang.",
  title(args) {
    return asString(args.command) ?? ""
  },
  readOnly(args) {
    const command = commandOf(args)
    if (COMPOUND_COMMAND.test(command)) return false
    return READ_ONLY_COMMAND.test(command)
  },
  permission(args) {
    const command = commandOf(args)
    if (COMPOUND_COMMAND.test(command)) return { subject: command }
    const words = command.split(/\s+/)
    if (words.length < 2) return { subject: command, suggestion: `bash(${command})` }
    return { subject: command, suggestion: `bash(${words[0]} ${words[1]}*)` }
  },
  async execute(args, signal) {
    const command = commandOf(args)
    if (!command) return { output: "(no command provided)" }

    const proc = Bun.spawn(["bash", "-c", command], {
      cwd: process.cwd(),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })

    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      proc.kill()
    }, TIMEOUT_MS)
    const onAbort = () => proc.kill()
    signal?.addEventListener("abort", onAbort)

    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      const output = [stdout, stderr]
        .filter((part) => part.length > 0)
        .join("\n")
        .trimEnd()
      let footer = `(exit code ${exitCode})`
      if (signal?.aborted) footer = "(interrupted by user)"
      if (timedOut) footer = `(timed out after ${TIMEOUT_MS / 1000}s and was killed)`
      return { output: output ? `${output}\n${footer}` : footer }
    } finally {
      clearTimeout(timeout)
      signal?.removeEventListener("abort", onAbort)
    }
  },
}
