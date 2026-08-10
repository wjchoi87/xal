import type { Plugin } from "../types"
import { registerTuiCommands } from "./commands"

const plugin: Plugin = {
  name: "tui",
  register(ctx) {
    registerTuiCommands(ctx)
    const events = ctx.events
    ctx.registerUi({
      id: "tui",
      start: async (options) => (await import("./app")).startTui(events, options),
    })
  },
}

export default plugin
