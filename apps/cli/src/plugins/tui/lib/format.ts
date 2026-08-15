import type { BackgroundCounts } from "../../../background/registry"

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
  const thousands = tokens / 1000
  return thousands < 99.95 ? `${thousands.toFixed(1)}K` : `${Math.round(thousands)}K`
}

export function formatBackgroundSummary(
  counts: BackgroundCounts,
  openShortcut: string | undefined,
): string | undefined {
  const parts: string[] = []
  if (counts.runningAgents > 0) {
    parts.push(`${counts.runningAgents} ${counts.runningAgents === 1 ? "agent" : "agents"}`)
  }
  if (counts.runningJobs > 0) parts.push(`${counts.runningJobs} ${counts.runningJobs === 1 ? "job" : "jobs"}`)
  if (counts.done > 0) parts.push(`${counts.done} done`)
  if (counts.failed > 0) parts.push(`${counts.failed} failed`)
  if (parts.length === 0) return undefined
  return [...parts, ...(openShortcut === undefined ? [] : [openShortcut])].join(" · ")
}
