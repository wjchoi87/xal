import { parseBoundedToolOutput, toolFailed } from "../../../tools/output"
import type { ProcessExecution } from "../../../tools/types"
import { displayWidth } from "../lib/text"
import { isNotice } from "./lines"

export function summarizeToolOutput(output: string): string {
  const bounded = parseBoundedToolOutput(output)
  if (bounded) return `${bounded.lines.toLocaleString()} ${bounded.lines === 1 ? "line" : "lines"} · truncated`

  const lines = output
    .split("\n")
    .filter((line) => !isNotice(line))
    .filter((line) => line.length > 0)
  if (lines.length === 0) return "no output"
  if (lines.length === 1) {
    const line = lines[0]!
    return displayWidth(line) <= 24 ? line : "1 line"
  }
  return `${lines.length} lines`
}

export function toolOutputFailed(output: string, execution?: ProcessExecution): boolean {
  if (toolFailed(output)) return true
  if (execution) return execution.status !== "exited" || execution.exitCode !== 0
  const exitCode = /\(exit code (\d+)(?: · [^)]*)?\)(?:\n\nFull output saved to: .+)?\s*$/.exec(output)
  if (exitCode && exitCode[1] !== "0") return true
  return /\(timed out after |\(interrupted by user\)|\(terminated by signal\)/.test(output)
}
