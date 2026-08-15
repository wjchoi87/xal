import { terminalPresentation } from "../terminal"

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })
const CONTROL_CHARS =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u0085\u200B-\u200F\u2028-\u202E\u2060\u2066-\u2069\uFEFF]/g

export function displayWidth(text: string): number {
  return Bun.stringWidth(text)
}

export function sanitize(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(CONTROL_CHARS, "")
}

export function terminalGlyph(unicode: string, fallback: string): string {
  if (!terminalPresentation.unicode) return fallback
  return displayWidth(unicode) === 1 ? unicode : fallback
}

export function sliceToWidth(text: string, width: number): string {
  if (width <= 0) return ""
  if (displayWidth(text) <= width) return text

  let result = ""
  let used = 0
  for (const { segment } of segmenter.segment(text)) {
    const next = displayWidth(segment)
    if (used + next > width) break
    result += segment
    used += next
  }
  return result
}

export function truncateToWidth(text: string, width: number): string {
  if (width <= 0) return ""
  if (displayWidth(text) <= width) return text
  if (width === 1) return "…"
  return `${sliceToWidth(text, width - 1)}…`
}

export function firstLine(text: string): string {
  return sanitize(text).split("\n", 1)[0]?.trim() ?? ""
}
