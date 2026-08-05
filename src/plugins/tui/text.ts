const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })
const timeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
})

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

export function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0.1, milliseconds / 1000)
  if (seconds < 10) return `${seconds.toFixed(1)}s`
  if (seconds < 60) return `${Math.round(seconds)}s`
  const minutes = Math.floor(seconds / 60)
  const remainder = Math.round(seconds % 60)
  return `${minutes}m ${remainder}s`
}

export function formatTimestamp(timestamp: number): string {
  return timeFormatter.format(timestamp)
}

export function compactPath(path: string): string {
  const home = process.env.HOME
  if (!home || (path !== home && !path.startsWith(`${home}/`))) return path
  return `~${path.slice(home.length)}`
}
