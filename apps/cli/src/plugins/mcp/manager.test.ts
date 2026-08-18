import { expect, test } from "bun:test"
import { McpManager } from "./manager"

test("MCP manager exposes typed status and removes a server", async () => {
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

  expect(manager.servers()).toEqual([
    {
      id: "local",
      configuredTransport: "stdio",
      state: "disabled",
      tools: 0,
      resources: 0,
      resourceTemplates: 0,
      prompts: 0,
    },
  ])
  expect(manager.statusLines()).toEqual(["local · disabled"])

  await manager.remove("local")

  expect(manager.servers()).toEqual([])
  expect(manager.statusLines()).toEqual(["No MCP servers configured."])
  await expect(manager.remove("local")).rejects.toThrow("unknown MCP server: local")
})
