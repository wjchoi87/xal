import { displayPath, resolveFilePath } from "../../lib/path"

const TIMEOUT_MS = 30_000
const MAX_OUTPUT_CHARS = 30_000

export interface RgOutcome {
  lines: string[]
  aborted: boolean
}

export function targetArgs(path: string | undefined, cwd: string): string[] {
  if (!path) return []
  if (resolveFilePath(path, cwd) === cwd) return []
  return [displayPath(path, cwd)]
}

function rgPath(): string {
  const path = Bun.which("rg")
  if (path) return path
  throw new Error(
    "ripgrep (rg) is not installed or not on PATH. Install it: brew install ripgrep (macOS), apt install ripgrep (Debian/Ubuntu), winget install BurntSushi.ripgrep.MSVC (Windows).",
  )
}

export async function runRg(argv: string[], cwd: string, signal?: AbortSignal): Promise<RgOutcome> {
  const proc = Bun.spawn([rgPath(), ...argv], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })

  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    proc.kill()
  }, TIMEOUT_MS)
  const onAbort = () => proc.kill()
  signal?.addEventListener("abort", onAbort)

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    if (timedOut) throw new Error(`Search timed out after ${TIMEOUT_MS / 1000}s`)
    if (signal?.aborted) return { lines: [], aborted: true }
    if (exitCode > 1) throw new Error(`ripgrep error: ${stderr.trim().split("\n")[0] ?? `exit code ${exitCode}`}`)
    return { lines: stdout.split("\n").filter((line) => line.length > 0), aborted: false }
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener("abort", onAbort)
  }
}

export function formatResults(
  header: string,
  lines: string[],
  limit: number,
  footer: (shown: number, total: number) => string,
): string {
  const total = lines.length
  const shown = lines.slice(0, limit)
  let chars = shown.reduce((sum, line) => sum + line.length + 1, 0)
  while (shown.length > 1 && chars > MAX_OUTPUT_CHARS) {
    chars -= (shown.pop()?.length ?? 0) + 1
  }
  if (shown.length === total) return [header, ...shown].join("\n")
  return [header, ...shown, footer(shown.length, total)].join("\n")
}
