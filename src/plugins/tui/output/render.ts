import { StyledText, stringToStyledText, stripAnsiSequences, type RGBA, type TextChunk } from "@opentui/core"
import { parseBoundedToolOutput } from "../../../tools/output"
import { displayWidth, truncateToWidth } from "../lib/text"
import { COLORS } from "../theme/colors"
import { muted, paint } from "../theme/styles"
import { parseDiff } from "./diff"
import { classifyLine, cleanLines, cropLines, type OutputLine, type OutputLineKind } from "./lines"

export const MAX_OUTPUT_ROWS = 8

function raw(text: string): TextChunk {
  return stringToStyledText(text).chunks[0]!
}

export function lineColor(kind: OutputLineKind): RGBA {
  switch (kind) {
    case "added":
      return COLORS.success
    case "removed":
    case "error":
      return COLORS.error
    case "hunk":
      return COLORS.warning
    case "faint":
    case "plain":
      return COLORS.faint
  }
}

function contentChunk(line: OutputLine): TextChunk {
  if (line.kind === "faint" || line.kind === "plain") return muted(line.text)
  return paint(lineColor(line.kind), line.text)
}

export function renderToolOutput(
  output: string,
  width: number,
  maxRows = MAX_OUTPUT_ROWS,
): { content: StyledText; rows: number } {
  const bounded = parseBoundedToolOutput(output)
  const recovery = bounded ? `Full output saved to: ${bounded.path}` : undefined
  const recoveryRows = recovery ? Math.max(1, Math.ceil(displayWidth(recovery) / width)) : 0
  const sourceLines = cleanLines(stripAnsiSequences(output))
  const parsed = parseDiff(sourceLines) ?? sourceLines.map(classifyLine)
  const visible = cropLines(
    recovery ? parsed.filter((line) => line.text !== recovery) : parsed,
    Math.max(0, maxRows - recoveryRows),
  )
  const lines = recovery ? [...visible, classifyLine(recovery)] : visible
  const chunks: TextChunk[] = []
  let rows = 0

  for (const [index, line] of lines.entries()) {
    const number = line.number ? `${line.number.padStart(4)} ` : ""
    const available = Math.max(1, width - displayWidth(number))
    const isRecovery = line.text === recovery
    if (number) chunks.push(muted(number))
    chunks.push(contentChunk({ ...line, text: isRecovery ? line.text : truncateToWidth(line.text, available) }))
    rows += isRecovery ? Math.max(1, Math.ceil(displayWidth(line.text) / available)) : 1
    if (index < lines.length - 1) chunks.push(raw("\n"))
  }

  return { content: new StyledText(chunks), rows: Math.max(1, rows) }
}
