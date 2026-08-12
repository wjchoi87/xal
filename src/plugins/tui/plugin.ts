import type { Plugin } from "../types"
import { registerTuiCommands } from "./commands"
import { parseTuiConfig } from "./config"

const plugin: Plugin = {
  name: "tui",
  register(ctx) {
    const config = parseTuiConfig(ctx.config)
    registerTuiCommands(ctx)
    const events = ctx.events
    ctx.registerUi({
      id: "tui",
      start: async (options) => (await import("./app")).startTui(events, config, options),
    })
  },
}

export default plugin
