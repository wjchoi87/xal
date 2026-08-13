import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { disposeShellSession, executeShellCommand } from "./shell"
import { bashTool } from "./tool"

const sessions = new Set<string>()

async function run(sessionId: string, command: string, cwd: string): Promise<string> {
  sessions.add(sessionId)
  let output = ""
  const execution = executeShellCommand(sessionId, command, cwd, undefined, (text) => {
    output += text
  })
  const code = await execution.done
  if (code !== 0) throw new Error(`command exited with ${code}: ${command}`)
  return output.trim()
}

afterEach(() => {
  for (const sessionId of sessions) disposeShellSession(sessionId)
  sessions.clear()
})

test("keeps persistent shell state inside its owning session", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "tack-shell-session-test-"))
  const nested = join(workspace, "nested")
  await mkdir(nested)
  const first = crypto.randomUUID()
  const second = crypto.randomUUID()

  try {
    await run(first, "cd nested", workspace)

    expect(await run(first, "pwd", workspace)).toBe(nested)
    expect(await run(second, "pwd", workspace)).toBe(workspace)
  } finally {
    disposeShellSession(first)
    disposeShellSession(second)
    await rm(workspace, { recursive: true, force: true })
  }
})

test("rejects managed background processes in task agents", async () => {
  await expect(
    bashTool.execute(
      { command: "sleep 30", background: true },
      {
        cwd: process.cwd(),
        sessionId: crypto.randomUUID(),
        sessionKind: "subagent",
        signal: new AbortController().signal,
        update() {},
      },
    ),
  ).rejects.toThrow("background Bash is unavailable in task agents")
})
