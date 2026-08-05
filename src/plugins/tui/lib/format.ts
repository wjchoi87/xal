const timeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
})

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

export function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens)
  if (tokens < 10_000) return `${(tokens / 1000).toFixed(1)}k`
  return `${Math.round(tokens / 1000)}k`
}

export function compactPath(path: string): string {
  const home = process.env.HOME
  if (!home || (path !== home && !path.startsWith(`${home}/`))) return path
  return `~${path.slice(home.length)}`
}
