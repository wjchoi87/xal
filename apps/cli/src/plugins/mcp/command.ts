import type { Command, CommandContext, SelectOption } from "../../commands/types"
import { findProjectRoot } from "../../project/root"
import { redactText } from "../../secrets/redactor"
import type { McpManager, McpServerStatus } from "./manager"
import { deleteMcpServer } from "./project"

type McpAction = "reconnect" | "delete"

function printStatus(manager: McpManager, print: (line: string) => void, server?: string): void {
  for (const line of manager.statusLines(server)) print(redactText(line))
}

function detail(server: McpServerStatus): string {
  const transport = server.connectionTransport ?? server.configuredTransport
  return `${server.state} · ${transport}`
}

function note(server: McpServerStatus): string {
  const capabilities = `${server.tools} tools · ${server.resources} resources · ${server.resourceTemplates} templates · ${server.prompts} prompts`
  return server.warning ? `${capabilities} · ${server.warning}` : capabilities
}

function ensureIdle(ctx: CommandContext): void {
  if (ctx.session.currentState !== "idle" || ctx.session.hasPendingAsyncWork()) {
    throw new Error("finish or interrupt the current work before changing MCP servers")
  }
}

async function reconnect(manager: McpManager, ctx: CommandContext, server?: string): Promise<void> {
  ensureIdle(ctx)
  ctx.busy(server ? `Connecting ${server}` : "Connecting MCP servers")
  await manager.reconnect(server).finally(() => ctx.busy())
  printStatus(manager, ctx.print, server)
}

async function remove(manager: McpManager, ctx: CommandContext, server: McpServerStatus): Promise<void> {
  const confirmed = await ctx.select({
    options: [
      { label: `Delete ${server.id}`, detail: "disconnect and remove its configuration", value: true },
      { label: "Cancel", detail: "keep this MCP server", active: true, value: false },
    ],
  })
  if (!confirmed) return
  ensureIdle(ctx)
  ctx.busy(`Deleting ${server.id}`)
  try {
    const root = await findProjectRoot(process.cwd())
    const source = await deleteMcpServer(root, server.id)
    await manager.remove(server.id)
    ctx.print(`deleted ${server.id} · ${source}`)
  } finally {
    ctx.busy()
  }
}

async function manage(manager: McpManager, ctx: CommandContext): Promise<void> {
  const servers = manager.servers()
  if (servers.length === 0) {
    ctx.print("No MCP servers configured.")
    return
  }
  const server = await ctx.select({
    search: "filter MCP servers",
    options: servers.map((entry) => ({
      label: entry.id,
      detail: detail(entry),
      note: note(entry),
      value: entry,
    })),
  })
  if (!server) return
  const options: SelectOption<McpAction>[] = []
  if (server.state !== "disabled") {
    options.push({ label: "Reconnect", detail: `restart ${server.id}`, value: "reconnect" })
  }
  options.push({ label: "Delete", detail: `remove ${server.id}`, value: "delete" })
  const action = await ctx.select<McpAction>({ options })
  if (action === "reconnect") {
    await reconnect(manager, ctx, server.id)
    return
  }
  if (action === "delete") await remove(manager, ctx, server)
}

export function mcpCommand(manager: McpManager): Command {
  return {
    name: "mcp",
    describe: "view and manage MCP servers",
    async run(args, ctx) {
      if (args.length === 0) {
        await manage(manager, ctx)
        return
      }
      if (args[0] !== "reconnect" || args.length > 2) {
        throw new Error("usage: /mcp [reconnect [server]]")
      }
      await reconnect(manager, ctx, args[1])
    },
  }
}
