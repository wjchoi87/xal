import { StyledText, stringToStyledText, stripAnsiSequences, type TextChunk } from "@opentui/core"
import { displayWidth, truncateToWidth } from "../lib/text"
import { COLORS } from "../theme/colors"
import { muted, paint } from "../theme/styles"
import { parseDiff } from "./diff"
import { classifyLine, cleanLines, cropLines, type OutputLine } from "./lines"

export const MAX_OUTPUT_ROWS = 8

function raw(text: string): TextChunk {
  return stringToStyledText(text).chunks[0]!
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

export function renderToolOutput(
  output: string,
  width: number,
  maxRows = MAX_OUTPUT_ROWS,
): { content: StyledText; rows: number } {
  const sourceLines = cleanLines(stripAnsiSequences(output))
  const parsed = parseDiff(sourceLines) ?? sourceLines.map(classifyLine)
  const lines = cropLines(parsed, maxRows)
  const chunks: TextChunk[] = []

  for (const [index, line] of lines.entries()) {
    const number = line.number ? `${line.number.padStart(4)} ` : ""
    const available = Math.max(1, width - displayWidth(number))
    if (number) chunks.push(muted(number))
    chunks.push(contentChunk({ ...line, text: truncateToWidth(line.text, available) }))
    if (index < lines.length - 1) chunks.push(raw("\n"))
  }

  return { content: new StyledText(chunks), rows: Math.max(1, lines.length) }
}
