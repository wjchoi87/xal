import { expect, test } from "bun:test"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { setupAgentSessionTests, ScriptedProvider } from "../../agent/session/test-support"
import type { CommandContext } from "../../commands/types"
import { agentHome, userConfigPath } from "../../config/paths"
import { mcpCommand } from "./command"
import { McpManager, type McpServerStatus } from "./manager"

test("interactive MCP deletion confirms, removes the source config, and disconnects the server", async () => {
  const originalCwd = process.cwd()
  const harness = await setupAgentSessionTests("mcp-command-test-")
  const root = join(agentHome(), "project")
  await mkdir(join(root, ".git"), { recursive: true })
  process.chdir(root)
  await writeFile(
    userConfigPath(),
    `${JSON.stringify({
      provider: "kept",
      pluginConfig: {
        mcp: {
          servers: {
            local: { transport: "stdio", command: "node", enabled: false },
          },
        },
      },
    })}\n`,
  )
  const manager = new McpManager(
    [
      {
        id: "local",
        transport: "stdio",
        command: "node",
        args: [],
        env: {},
        enabled: false,
        timeoutMs: 30_000,
      },
    ],
    { register() {}, unregister() {} },
  )
  const session = harness.createSession(new ScriptedProvider([]), { cwd: root })
  const selections = [0, 0, 0]
  const lines: string[] = []
  const busy: (string | undefined)[] = []
  const ctx: CommandContext = {
    session,
    print: (line) => lines.push(line),
    busy: (label) => busy.push(label),
    select: async (request) => request.options[selections.shift() ?? -1]?.value,
    restore() {},
    ask: async () => undefined,
    askSecret: async () => undefined,
  }

  try {
    await mcpCommand(manager).run([], ctx)

    expect(lines).toEqual(["deleted local · global"])
    expect(busy).toEqual(["Deleting local", undefined])
    expect(manager.servers()).toEqual([])
    expect(JSON.parse(await readFile(userConfigPath(), "utf8"))).toEqual({
      provider: "kept",
      pluginConfig: { mcp: { servers: {} } },
    })
  } finally {
    session.disposeAsyncDelivery()
    process.chdir(originalCwd)
    await harness.cleanup()
  }
})

class RecordingMcpManager extends McpManager {
  readonly reconnected: (string | undefined)[] = []

  constructor() {
    super([], { register() {}, unregister() {} })
  }

  override servers(): McpServerStatus[] {
    return ["first", "second"].map((id) => ({
      id,
      configuredTransport: "stdio",
      connectionTransport: "stdio",
      state: "connected",
      tools: 1,
      resources: 0,
      resourceTemplates: 0,
      prompts: 0,
    }))
  }

  override statusLines(id?: string): string[] {
    return id ? [`${id} · connected`] : ["first · connected", "second · connected"]
  }

  override async reconnect(server?: string): Promise<void> {
    this.reconnected.push(server)
  }
}

test("interactive MCP reconnect targets and reports only the selected server", async () => {
  const harness = await setupAgentSessionTests("mcp-reconnect-test-")
  const manager = new RecordingMcpManager()
  const session = harness.createSession(new ScriptedProvider([]))
  const selections = [1, 0]
  const lines: string[] = []
  const busy: (string | undefined)[] = []
  const ctx: CommandContext = {
    session,
    print: (line) => lines.push(line),
    busy: (label) => busy.push(label),
    select: async (request) => request.options[selections.shift() ?? -1]?.value,
    restore() {},
    ask: async () => undefined,
    askSecret: async () => undefined,
  }

  try {
    await mcpCommand(manager).run([], ctx)

    expect(manager.reconnected).toEqual(["second"])
    expect(lines).toEqual(["second · connected"])
    expect(busy).toEqual(["Connecting second", undefined])
  } finally {
    session.disposeAsyncDelivery()
    await harness.cleanup()
  }
})
