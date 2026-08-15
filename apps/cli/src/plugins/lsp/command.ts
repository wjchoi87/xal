import type { Command } from "../../commands/types"
import type { LspManager } from "./manager"

export function lspCommand(manager: LspManager): Command {
  return {
    name: "lsp",
    describe: "show or restart language servers",
    async run(args, ctx) {
      if (args.length === 0) {
        for (const line of manager.statusLines(ctx.session.currentWorkingDirectory)) ctx.print(line)
        return
      }
      if (args[0] !== "restart" || args.length > 2) {
        throw new Error("usage: /lsp [restart [server]]")
      }
      ctx.busy("Restarting language servers")
      await manager.restart(args[1]).finally(() => ctx.busy())
      for (const line of manager.statusLines(ctx.session.currentWorkingDirectory)) ctx.print(line)
    },
  }
}
