import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

test("permission store serializes concurrent updates, deduplicates rules, and writes securely", async () => {
  const previousHome = process.env.TACK_HOME
  const home = await mkdtemp(join(tmpdir(), "tack-permission-store-test-"))
  process.env.TACK_HOME = home
  try {
    const { loadProjectRules, saveProjectRule } = await import("./store")

    await Promise.all([
      saveProjectRule("/workspace/a", "write(/workspace/a/*)"),
      saveProjectRule("/workspace/a", "bash(git status)"),
      saveProjectRule("/workspace/b", "write(/workspace/b/*)"),
      saveProjectRule("/workspace/a", "write(/workspace/a/*)"),
    ])

    expect(await loadProjectRules("/workspace/a")).toEqual(["write(/workspace/a/*)", "bash(git status)"])
    expect(await loadProjectRules("/workspace/b")).toEqual(["write(/workspace/b/*)"])
    const path = join(home, "permissions.json")
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      version: 1,
      projects: {
        "/workspace/a": { allow: ["write(/workspace/a/*)", "bash(git status)"] },
        "/workspace/b": { allow: ["write(/workspace/b/*)"] },
      },
    })
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  } finally {
    if (previousHome === undefined) delete process.env.TACK_HOME
    else process.env.TACK_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

test("permission store rejects malformed data without overwriting it", async () => {
  const previousHome = process.env.TACK_HOME
  const home = await mkdtemp(join(tmpdir(), "tack-permission-store-test-"))
  process.env.TACK_HOME = home
  try {
    const { loadProjectRules, saveProjectRule } = await import("./store")
    const path = join(home, "permissions.json")
    const contents = '{"version":1,"projects":{"/workspace":{"allow":["read",42]}}}\n'
    await mkdir(home, { recursive: true })
    await writeFile(path, contents)

    await expect(loadProjectRules("/workspace")).rejects.toThrow("permissions.json is malformed — fix or delete it")
    await expect(saveProjectRule("/workspace", "write(*)")).rejects.toThrow(
      "permissions.json is malformed — fix or delete it",
    )
    expect(await readFile(path, "utf8")).toBe(contents)
  } finally {
    if (previousHome === undefined) delete process.env.TACK_HOME
    else process.env.TACK_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})
