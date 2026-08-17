import { expect, test } from "bun:test"
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { appInfo } from "../app-info"
import { pathExists, readJsonFile, writeNewSecureText, writeSecureJson, writeSecureText } from "./fs"

async function withDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), `${appInfo.name}-fs-test-`))
  try {
    await run(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test("reads back a missing file as undefined and refuses to guess at malformed JSON", async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, "state.json")
    expect(await readJsonFile(path)).toBeUndefined()
    expect(await pathExists(path)).toBe(false)

    await writeFile(path, "{ not json")

    await expect(readJsonFile(path)).rejects.toThrow(`${path} is malformed — fix or delete it`)
  })
})

test("writes JSON that reads back in the same shape with owner-only permissions", async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, "nested", "state.json")
    const value = { version: 1, entries: ["a", "b"], nested: { enabled: true } }

    await writeSecureJson(path, value)

    expect(await readJsonFile(path)).toEqual(value)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })
})

test("replaces existing content without leaving a temporary file behind", async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, "state.json")
    await writeSecureText(path, "first")
    await writeSecureText(path, "second")

    expect(await readFile(path, "utf8")).toBe("second")
    expect(await readdir(directory)).toEqual(["state.json"])
  })
})

test("tightens permissions on a file that was previously world readable", async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, "state.json")
    await writeFile(path, "loose", { mode: 0o644 })

    await writeSecureText(path, "tight")

    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })
})

test("claims a path exclusively so a second writer cannot take it over", async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, "lease.json")

    await writeNewSecureText(path, "owner-a")

    await expect(writeNewSecureText(path, "owner-b")).rejects.toThrow()
    expect(await readFile(path, "utf8")).toBe("owner-a")
    expect(await readdir(directory)).toEqual(["lease.json"])
  })
})

test("lets exactly one concurrent writer claim a path", async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, "lease.json")

    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, index) => writeNewSecureText(path, `owner-${index}`)),
    )

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
    expect(await readdir(directory)).toEqual(["lease.json"])
    expect((await readFile(path, "utf8")).startsWith("owner-")).toBe(true)
  })
})
