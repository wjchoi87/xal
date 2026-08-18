import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { appEnvVar, appInfo } from "../../app-info"
import { projectConfigPath, projectMcpConfigPath, userConfigPath } from "../../config/paths"
import { loadSettings } from "../../config/settings"
import { deleteMcpServer, parseProjectMcpConfig, prepareProjectMcp } from "./project"

const originalCwd = process.cwd()
const homeEnv = appEnvVar("HOME")
const originalHome = process.env[homeEnv]
let directory = ""
let home = ""
let project = ""

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), `${appInfo.name}-mcp-project-test-`))
  home = join(directory, "home")
  project = join(directory, "project")
  await mkdir(join(project, ".git"), { recursive: true })
  process.env[homeEnv] = home
  process.chdir(project)
  project = process.cwd()
  await writeJson(join(home, "trust.json"), [project])
})

afterEach(async () => {
  process.chdir(originalCwd)
  if (originalHome === undefined) delete process.env[homeEnv]
  else process.env[homeEnv] = originalHome
  await rm(directory, { recursive: true, force: true })
})

describe("project MCP configuration", () => {
  test("parses stdio and HTTP servers without expanding environment references", () => {
    expect(
      parseProjectMcpConfig({
        mcpServers: {
          local: {
            command: "node",
            args: ["server.js"],
            env: { SERVICE_TOKEN: "${SERVICE_TOKEN}" },
          },
          remote: {
            type: "streamable-http",
            url: "https://example.com/mcp",
            headers: { Authorization: "Bearer ${MCP_TOKEN}" },
          },
        },
      }),
    ).toEqual({
      local: {
        transport: "stdio",
        command: "node",
        args: ["server.js"],
        env: { SERVICE_TOKEN: "${SERVICE_TOKEN}" },
      },
      remote: {
        transport: "http",
        url: "https://example.com/mcp",
        headers: { Authorization: "Bearer ${MCP_TOKEN}" },
      },
    })
  })

  test("rejects unsupported fields, invalid names, and unsafe URLs", () => {
    expect(() => parseProjectMcpConfig({ mcpServers: { BadName: { command: "node" } } })).toThrow("invalid server name")
    expect(() => parseProjectMcpConfig({ mcpServers: { local: { command: "node", mystery: true } } })).toThrow(
      ".mcp.json.mcpServers.local.mystery is not supported",
    )
    expect(() =>
      parseProjectMcpConfig({ mcpServers: { remote: { type: "http", url: "file:///tmp/socket" } } }),
    ).toThrow("must use http or https")
  })

  test("ignores untrusted discovery and rejects a malformed configured server map", async () => {
    await writeJson(join(home, "trust.json"), [])
    await writeFile(projectMcpConfigPath(project), "{malformed")
    const untrusted = await loadSettings()
    let choices = 0
    expect(
      await prepareProjectMcp(project, untrusted, {
        print() {},
        choose: async () => {
          choices += 1
          return 0
        },
      }),
    ).toBe(untrusted)
    expect(choices).toBe(0)

    await writeJson(join(home, "trust.json"), [project])
    await writeJson(userConfigPath(), { pluginConfig: { mcp: { servers: "malformed" } } })
    await writeJson(projectMcpConfigPath(project), { mcpServers: { local: { command: "node" } } })
    await expect(
      prepareProjectMcp(project, await loadSettings(), { print() {}, choose: async () => 0 }),
    ).rejects.toThrow("pluginConfig.mcp.servers must be an object")
  })

  test("uses discovered servers for one session without writing configuration", async () => {
    await writeJson(projectMcpConfigPath(project), {
      mcpServers: { local: { command: "node", env: { TOKEN: "${TOKEN}" } } },
    })
    const settings = await loadSettings()
    const choices: string[][] = []
    const prepared = await prepareProjectMcp(project, settings, {
      print() {},
      choose: async (options) => {
        choices.push(options)
        return 0
      },
    })

    expect(choices).toEqual([["Use for this session", "Add to this project", "Add globally", "Do not use"]])
    expect(prepared.pluginConfig.mcp).toEqual({
      servers: {
        local: { transport: "stdio", command: "node", env: { TOKEN: "${TOKEN}" } },
      },
    })
    expect(await readFile(projectMcpConfigPath(project), "utf8")).toContain("${TOKEN}")
    await expect(readFile(projectConfigPath(project), "utf8")).rejects.toThrow()
    await expect(readFile(userConfigPath(), "utf8")).rejects.toThrow()
  })

  test("imports only new names into the project and does not prompt again", async () => {
    await writeJson(userConfigPath(), {
      provider: "kept",
      pluginConfig: {
        mcp: { servers: { existing: { transport: "stdio", command: "user-command" } } },
      },
    })
    await writeJson(projectConfigPath(project), { pluginConfig: { other: { kept: true } } })
    await writeJson(projectMcpConfigPath(project), {
      mcpServers: {
        existing: { command: "project-command" },
        added: { type: "http", url: "https://example.com/mcp" },
      },
    })
    const lines: string[] = []
    let choices = 0
    const prepared = await prepareProjectMcp(project, await loadSettings(), {
      print: (line) => lines.push(line),
      choose: async () => {
        choices += 1
        return 1
      },
    })

    expect(choices).toBe(1)
    expect(lines.at(-1)).toBe("Keeping existing Xal configuration for: existing")
    expect(prepared.pluginConfig.mcp?.servers).toEqual({
      existing: { transport: "stdio", command: "user-command" },
      added: { transport: "http", url: "https://example.com/mcp" },
    })
    expect(JSON.parse(await readFile(projectConfigPath(project), "utf8"))).toEqual({
      pluginConfig: {
        other: { kept: true },
        mcp: { servers: { added: { transport: "http", url: "https://example.com/mcp" } } },
      },
    })

    await prepareProjectMcp(project, prepared, {
      print() {},
      choose: async () => {
        choices += 1
        return 3
      },
    })
    expect(choices).toBe(1)
  })

  test("imports globally, rejects per launch, and deletes from the effective source", async () => {
    await writeJson(projectMcpConfigPath(project), { mcpServers: { shared: { command: "node" } } })
    let settings = await loadSettings()
    settings = await prepareProjectMcp(project, settings, { print() {}, choose: async () => 3 })
    settings = await prepareProjectMcp(project, settings, { print() {}, choose: async () => 3 })
    expect(settings.pluginConfig.mcp).toBeUndefined()

    settings = await prepareProjectMcp(project, settings, { print() {}, choose: async () => 2 })
    expect(settings.pluginConfig.mcp?.servers).toEqual({
      shared: { transport: "stdio", command: "node" },
    })
    expect((await stat(userConfigPath())).mode & 0o777).toBe(0o600)

    await writeJson(projectConfigPath(project), {
      pluginConfig: { mcp: { servers: { shared: { transport: "stdio", command: "project-node" } } } },
    })
    expect(await deleteMcpServer(project, "shared")).toBe("project")
    expect(await deleteMcpServer(project, "shared")).toBe("global")
    expect(await deleteMcpServer(project, "shared")).toBe("session")
    expect(await deleteMcpServer(project, "constructor")).toBe("session")

    await writeJson(projectConfigPath(project), {
      pluginConfig: { mcp: { servers: { constructor: { transport: "stdio", command: "node" } } } },
    })
    expect(await deleteMcpServer(project, "constructor")).toBe("project")
  })
})
