const TIMEOUT_MS = 30_000

export interface RgOutcome {
  lines: string[]
  aborted: boolean
}

function rgPath(): string {
  const path = Bun.which("rg")
  if (path) return path
  throw new Error(
    "ripgrep (rg) is not installed or not on PATH. Install it: brew install ripgrep (macOS), apt install ripgrep (Debian/Ubuntu), winget install BurntSushi.ripgrep.MSVC (Windows).",
  )
}

export async function runRg(argv: string[], cwd: string, signal?: AbortSignal, separator = "\n"): Promise<RgOutcome> {
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
    return { lines: stdout.split(separator).filter((line) => line.length > 0), aborted: false }
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener("abort", onAbort)
  }
}
