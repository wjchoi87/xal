const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })

export function displayWidth(text: string): number {
  return Bun.stringWidth(text)
}

export function terminalGlyph(unicode: string, fallback: string): string {
  if (process.env.TERM === "dumb") return fallback
  return displayWidth(unicode) === 1 ? unicode : fallback
}

export function truncateToWidth(text: string, width: number): string {
  if (width <= 0) return ""
  if (displayWidth(text) <= width) return text
  if (width === 1) return "…"

  let result = ""
  let used = 0
  for (const { segment } of segmenter.segment(text)) {
    const next = displayWidth(segment)
    if (used + next > width - 1) break
    result += segment
    used += next
  }
  return `${result}…`
}

export function firstLine(text: string): string {
  return text.split("\n", 1)[0]?.trim() ?? ""
}
