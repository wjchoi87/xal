import type { Tool } from "./types"

const MAX_OUTPUT_CHARS = 30_000
const TIMEOUT_MS = 120_000

function truncateMiddle(text: string, max: number): string {
  if (text.length <= max) return text
  const half = Math.floor(max / 2)
  const omitted = text.length - max
  return `${text.slice(0, half)}\n… (${omitted} characters truncated) …\n${text.slice(-half)}`
}

export const bashTool: Tool = {
  name: "bash",
  description:
    "Execute a bash command in the user's current working directory. Returns combined stdout and stderr followed by the exit code. Use standard shell tools to read, search, and edit files, and to run builds or tests. Each command requires the user's approval before it runs.",
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
  async execute(args, signal) {
    const command = String(args.command ?? "").trim()
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
      let output = [stdout, stderr].filter((part) => part.length > 0).join("\n").trimEnd()
      output = truncateMiddle(output, MAX_OUTPUT_CHARS)
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
