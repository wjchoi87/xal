import type { Command } from "../../commands/types"
import { redactText } from "../../secrets/redactor"
import type { McpManager } from "./manager"

function printStatus(manager: McpManager, print: (line: string) => void): void {
  for (const line of manager.statusLines()) print(redactText(line))
}

export function mcpCommand(manager: McpManager): Command {
  return {
    name: "mcp",
    describe: "show or reconnect MCP servers",
    async run(args, ctx) {
      if (args.length === 0) {
        printStatus(manager, ctx.print)
        return
      }
      if (args[0] !== "reconnect" || args.length > 2) {
        throw new Error("usage: /mcp [reconnect [server]]")
      }
      ctx.busy("Connecting MCP servers")
      await manager.reconnect(args[1]).finally(() => ctx.busy())
      printStatus(manager, ctx.print)
    },
  }
}
