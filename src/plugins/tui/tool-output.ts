import { StyledText, stringToStyledText, stripAnsiSequences, type TextChunk } from "@opentui/core"
import { COLORS, muted, paint } from "./theme"
import { truncateToWidth } from "./text"

const MAX_OUTPUT_ROWS = 8

type OutputLineKind = "plain" | "faint" | "added" | "removed" | "hunk" | "error"

interface OutputLine {
  number: string
  text: string
  kind: OutputLineKind
}

function raw(text: string): TextChunk {
  return stringToStyledText(text).chunks[0]!
}

function cleanLines(output: string): string[] {
  const clean = stripAnsiSequences(output)
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .trimEnd()
  if (!clean) return ["(no output)"]
  const lines = clean.split("\n").filter((line) => line.trim() !== "(exit code 0)")
  return lines.length > 0 ? lines : ["(no output)"]
}

function plainLine(text: string): OutputLine {
  const exitCode = /^\(exit code (\d+)\)$/.exec(text.trim())
  if (exitCode) return { number: "", text: `exit code ${exitCode[1]}`, kind: "error" }
  if (/^(?:Tool failed:|\(interrupted by user\)|\(timed out after )/.test(text.trim())) {
    return { number: "", text, kind: "error" }
  }
  return { number: "", text, kind: "plain" }
}

function parseDiff(lines: string[]): OutputLine[] | undefined {
  if (!lines.some((line) => line.startsWith("@@"))) return undefined

  const parsed: OutputLine[] = []
  let oldLine: number | undefined
  let newLine: number | undefined
  for (const line of lines) {
    if (/^\((?:exit code \d+|interrupted by user|timed out after .+)\)$/.test(line.trim())) {
      parsed.push(plainLine(line))
      continue
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (hunk) {
      oldLine = Number(hunk[1])
      newLine = Number(hunk[2])
      parsed.push({ number: "", text: line, kind: "hunk" })
      continue
    }
    if (oldLine === undefined || newLine === undefined) {
      parsed.push({ number: "", text: line, kind: "faint" })
      continue
    }
    if (line.startsWith("-") && !line.startsWith("---")) {
      parsed.push({ number: String(oldLine), text: line, kind: "removed" })
      oldLine += 1
      continue
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      parsed.push({ number: String(newLine), text: line, kind: "added" })
      newLine += 1
      continue
    }
    parsed.push({ number: String(newLine), text: line, kind: "plain" })
    if (!line.startsWith("\\")) {
      oldLine += 1
      newLine += 1
    }
  }
  return parsed
}

function crop(lines: OutputLine[]): OutputLine[] {
  if (lines.length <= MAX_OUTPUT_ROWS) return lines
  const visible = lines.slice(-(MAX_OUTPUT_ROWS - 1))
  return [
    { number: "", text: `… ${lines.length - visible.length} earlier lines omitted`, kind: "faint" },
    ...visible,
  ]
}

function contentChunk(line: OutputLine): TextChunk {
  switch (line.kind) {
    case "added":
      return paint(COLORS.success, line.text)
    case "removed":
      return paint(COLORS.error, line.text)
    case "hunk":
      return paint(COLORS.warning, line.text)
    case "error":
      return paint(COLORS.error, line.text)
    case "faint":
    case "plain":
      return muted(line.text)
  }
}

export function renderToolOutput(output: string, width: number): { content: StyledText; rows: number } {
  const sourceLines = cleanLines(output)
  const plainLines = sourceLines.map(plainLine)
  const parsed = parseDiff(sourceLines) ?? plainLines
  const lines = crop(parsed)
  const chunks: TextChunk[] = []

  for (const [index, line] of lines.entries()) {
    const number = line.number ? `${line.number.padStart(4)} ` : ""
    const available = Math.max(1, width - Bun.stringWidth(number))
    if (number) chunks.push(muted(number))
    chunks.push(contentChunk({ ...line, text: truncateToWidth(line.text, available) }))
    if (index < lines.length - 1) chunks.push(raw("\n"))
  }

  return { content: new StyledText(chunks), rows: Math.max(1, lines.length) }
}

export function summarizeToolOutput(output: string): string {
  const lines = output
    .split("\n")
    .filter((line) => !/^\((?:exit code \d+|interrupted by user|timed out after .+)\)$/.test(line.trim()))
    .filter((line) => line.length > 0)
  if (lines.length === 0) return "no output"
  if (lines.length === 1) {
    const line = lines[0]!
    return Bun.stringWidth(line) <= 24 ? line : "1 line"
  }
  return `${lines.length} lines`
}

export function toolOutputFailed(output: string): boolean {
  const exitCode = /\(exit code (\d+)\)\s*$/.exec(output)
  if (exitCode && exitCode[1] !== "0") return true
  return /(?:^|\n)Tool failed:|\(timed out after |\(interrupted by user\)/.test(output)
}
