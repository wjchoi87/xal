import { appInfo } from "../app-info"
import type { CliContext } from "../cli/types"

const BAR_WIDTH = 24
const REDRAW_INTERVAL_MS = 80

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function totalBytes(header: string | null): number | undefined {
  if (!header) return undefined
  const total = Number(header)
  if (!Number.isSafeInteger(total) || total <= 0) return undefined
  return total
}

function progressLine(label: string, received: number, total: number | undefined): string {
  if (total === undefined) return `${label} ${formatSize(received)}`
  const ratio = Math.min(1, received / total)
  const filled = Math.round(ratio * BAR_WIDTH)
  const bar = `${"█".repeat(filled)}${"░".repeat(BAR_WIDTH - filled)}`
  const percent = `${Math.round(ratio * 100)}%`.padStart(4)
  return `${label} ${bar} ${percent} ${formatSize(received)}/${formatSize(total)}`
}

export async function downloadArtifact(url: string, label: string, ctx: CliContext): Promise<Uint8Array> {
  const response = await fetch(url, {
    headers: { "user-agent": `${appInfo.name}/${appInfo.version}`, "accept-encoding": "identity" },
  })
  if (!response.ok) throw new Error(`download failed: ${response.status} ${response.statusText}: ${url}`)
  if (!response.body) throw new Error(`download failed: no response body: ${url}`)

  const total = totalBytes(response.headers.get("content-length"))
  const live = process.stdout.isTTY === true
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  let drawnAt = 0

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      received += value.byteLength
      if (!live || Date.now() - drawnAt < REDRAW_INTERVAL_MS) continue
      drawnAt = Date.now()
      process.stdout.write(`\r\u001b[2K${progressLine(label, received, total)}`)
    }
  } finally {
    if (live) process.stdout.write("\r\u001b[2K")
  }

  ctx.print(progressLine(label, received, total))
  return Buffer.concat(chunks)
}
