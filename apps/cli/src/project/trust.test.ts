import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { appEnvVar, appInfo } from "../app-info"
import { projectConfigPath } from "../config/paths"
import { findProjectRoot } from "./root"
import { ensureWorkspaceTrust, forgetTrusted, isTrusted } from "./trust"

const originalCwd = process.cwd()
const homeEnv = appEnvVar("HOME")
const originalHome = process.env[homeEnv]
let directory = ""
let home = ""
let workspace = ""
let nested = ""

beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), `${appInfo.name}-trust-test-`)))
  home = join(directory, "home")
  workspace = join(directory, "workspace")
  nested = join(workspace, "packages", "app")
  await mkdir(join(workspace, ".git"), { recursive: true })
  await mkdir(nested, { recursive: true })
  process.env[homeEnv] = home
  process.chdir(nested)
})

afterEach(async () => {
  process.chdir(originalCwd)
  if (originalHome === undefined) delete process.env[homeEnv]
  else process.env[homeEnv] = originalHome
  await rm(directory, { recursive: true, force: true })
})

describe("workspace trust", () => {
  test("finds the nearest repository root and otherwise keeps the starting directory", async () => {
    expect(await findProjectRoot(nested)).toBe(workspace)

    const standalone = join(directory, "standalone", "nested")
    await mkdir(standalone, { recursive: true })
    expect(await findProjectRoot(standalone)).toBe(standalone)
  })

  test("headless startup ignores untrusted project configuration without blocking", async () => {
    const config = projectConfigPath(workspace)
    await mkdir(join(workspace, `.${appInfo.name}`), { recursive: true })
    await writeFile(config, JSON.stringify({ plugins: ["untrusted-plugin"] }))
    const lines: string[] = []

    expect(await ensureWorkspaceTrust({ print: (line) => lines.push(line) })).toBe(true)
    expect(await isTrusted(workspace)).toBe(false)
    expect(lines).toEqual([
      `ignoring project configuration in ${config} — run "${appInfo.name} trust grant" to enable it`,
    ])
  })

  test("interactive startup exits when the user rejects the workspace", async () => {
    const lines: string[] = []

    expect(
      await ensureWorkspaceTrust({
        print: (line) => lines.push(line),
        choose: async () => 1,
      }),
    ).toBe(false)
    expect(await isTrusted(workspace)).toBe(false)
    expect(lines.at(-1)).toBe("not trusted — exiting")
  })

  test("persists approval securely, skips later prompts, and can revoke it", async () => {
    let choices = 0
    const io = {
      print() {},
      choose: async () => {
        choices += 1
        return 0
      },
    }

    expect(await ensureWorkspaceTrust(io)).toBe(true)
    expect(await ensureWorkspaceTrust(io)).toBe(true)
    expect(choices).toBe(1)
    expect(await isTrusted(workspace)).toBe(true)

    const trustFile = join(home, "trust.json")
    expect(JSON.parse(await readFile(trustFile, "utf8"))).toEqual([workspace])
    expect((await stat(trustFile)).mode & 0o777).toBe(0o600)

    await forgetTrusted(workspace)
    expect(await isTrusted(workspace)).toBe(false)
    expect(JSON.parse(await readFile(trustFile, "utf8"))).toEqual([])
  })

  test("fails closed when persisted trust data is malformed", async () => {
    await mkdir(home, { recursive: true })
    await writeFile(join(home, "trust.json"), JSON.stringify({ trusted: [workspace] }))

    await expect(isTrusted(workspace)).rejects.toThrow("trust.json is malformed — fix or delete it")
  })
})
