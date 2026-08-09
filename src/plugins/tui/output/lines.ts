import { toolFailed } from "../../../tools/output"
import { sanitize } from "../lib/text"

export type OutputLineKind = "plain" | "faint" | "added" | "removed" | "hunk" | "error"

export interface OutputLine {
  number: string
  text: string
  kind: OutputLineKind
}

const NOTICE = /^\((?:exit code \d+|interrupted by user|timed out after .+)\)$/
const EXIT_CODE = /^\(exit code (\d+)\)$/
const FAILURE_NOTICE = /^\((?:interrupted by user\)|timed out after )/

export function isNotice(text: string): boolean {
  return NOTICE.test(text.trim())
}

export function cleanLines(output: string): string[] {
  const clean = sanitize(output).trimEnd()
  if (!clean) return ["(no output)"]
  const lines = clean.split("\n").filter((line) => line.trim() !== "(exit code 0)")
  return lines.length > 0 ? lines : ["(no output)"]
}

export function classifyLine(text: string): OutputLine {
  const trimmed = text.trim()
  const exitCode = EXIT_CODE.exec(trimmed)
  if (exitCode) return { number: "", text: `exit code ${exitCode[1]}`, kind: "error" }
  if (toolFailed(trimmed) || FAILURE_NOTICE.test(trimmed)) return { number: "", text, kind: "error" }
  return { number: "", text, kind: "plain" }
}

export function cropLines(lines: OutputLine[], maxRows: number): OutputLine[] {
  if (maxRows <= 0) return []
  if (lines.length <= maxRows) return lines
  if (maxRows === 1) return [{ number: "", text: `… ${lines.length} lines omitted`, kind: "faint" }]
  const visible = lines.slice(-(maxRows - 1))
  return [{ number: "", text: `… ${lines.length - visible.length} earlier lines omitted`, kind: "faint" }, ...visible]
}
