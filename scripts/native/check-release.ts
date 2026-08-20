import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const ROOT = resolve(import.meta.dir, "../..")
const VERSION = "0.0.0-check"

async function run(args: string[]): Promise<void> {
  const child = Bun.spawn([process.execPath, ...args], {
    cwd: ROOT,
    env: process.env,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  })
  const exitCode = await child.exited
  if (exitCode !== 0) throw new Error(`${args[0]} failed with exit code ${exitCode}`)
}

const directory = await mkdtemp(join(tmpdir(), "xal-release-check-"))
try {
  const executable = join(directory, process.platform === "win32" ? "xal.exe" : "xal")
  await run(["scripts/native/build.ts", "compile-host-check", VERSION, executable])
  await run(["scripts/native/smoke.ts", executable, VERSION])
} finally {
  await rm(directory, { recursive: true, force: true })
}
