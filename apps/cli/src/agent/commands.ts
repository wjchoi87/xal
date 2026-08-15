import { registerCommand } from "../commands/registry"
import type { Command } from "../commands/types"

const compactCommand: Command = {
  name: "compact",
  describe: "summarize the conversation so far to free context",
  async run(args, ctx) {
    const instructions = args.join(" ").trim()
    const outcome = await ctx.session.compact(instructions || undefined)
    switch (outcome) {
      case "busy":
        ctx.print("cannot compact while a turn is running")
        break
      case "nothing":
        ctx.print("the conversation is short enough that there is nothing to compact")
        break
      case "interrupted":
        ctx.print("compaction interrupted — the conversation is unchanged")
        break
      case "compacted":
        break
    }
  },
}

export function registerAgentCommands(): void {
  registerCommand(compactCommand)
}
