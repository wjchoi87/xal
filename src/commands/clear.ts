import type { Command } from "./types"

export const clearCommand: Command = {
  name: "clear",
  describe: "start a new session",
  async run(_args, ctx) {
    if (!ctx.session.reset()) ctx.print("cannot start a new session while a turn is running")
  },
}
