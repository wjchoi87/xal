export async function runGit(cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) throw new Error("Git command interrupted")
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const abort = (): void => proc.kill()
  signal?.addEventListener("abort", abort)
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    if (signal?.aborted) throw new Error("Git command interrupted")
    if (exitCode === 0) return stdout.trimEnd()
    const detail = stderr.trim().split("\n")[0]
    throw new Error(`git ${args[0]} failed${detail ? `: ${detail}` : ` with exit code ${exitCode}`}`)
  } finally {
    signal?.removeEventListener("abort", abort)
  }
}
