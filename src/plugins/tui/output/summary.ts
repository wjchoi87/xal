import { displayWidth } from "../lib/text"
import { isNotice } from "./lines"

export function summarizeToolOutput(output: string): string {
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

export function toolOutputFailed(output: string): boolean {
  const exitCode = /\(exit code (\d+)\)\s*$/.exec(output)
  if (exitCode && exitCode[1] !== "0") return true
  return /(?:^|\n)Tool failed:|\(timed out after |\(interrupted by user\)/.test(output)
}
