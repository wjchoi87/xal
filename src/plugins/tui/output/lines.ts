type OutputLineKind = "plain" | "faint" | "added" | "removed" | "hunk" | "error"

export interface OutputLine {
  number: string
  text: string
  kind: OutputLineKind
}

const NOTICE = /^\((?:exit code \d+|interrupted by user|timed out after .+)\)$/
const EXIT_CODE = /^\(exit code (\d+)\)$/
const FAILURE_PREFIX = /^(?:Tool failed:|\(interrupted by user\)|\(timed out after )/
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g

export function isNotice(text: string): boolean {
  return NOTICE.test(text.trim())
}

export function cleanLines(output: string): string[] {
  const clean = output.replace(/\r\n?/g, "\n").replace(CONTROL_CHARS, "").trimEnd()
  if (!clean) return ["(no output)"]
  const lines = clean.split("\n").filter((line) => line.trim() !== "(exit code 0)")
  return lines.length > 0 ? lines : ["(no output)"]
}

export function classifyLine(text: string): OutputLine {
  const exitCode = EXIT_CODE.exec(text.trim())
  if (exitCode) return { number: "", text: `exit code ${exitCode[1]}`, kind: "error" }
  if (FAILURE_PREFIX.test(text.trim())) return { number: "", text, kind: "error" }
  return { number: "", text, kind: "plain" }
}

export function cropLines(lines: OutputLine[], maxRows: number): OutputLine[] {
  if (lines.length <= maxRows) return lines
  const visible = lines.slice(-(maxRows - 1))
  return [{ number: "", text: `… ${lines.length - visible.length} earlier lines omitted`, kind: "faint" }, ...visible]
}
