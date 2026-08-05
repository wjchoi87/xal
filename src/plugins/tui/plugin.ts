import type { Plugin } from "../types"

const plugin: Plugin = {
  name: "tui",
  register(ctx) {
    const events = ctx.events
    ctx.registerUi({
      id: "tui",
      start: async () => (await import("./app")).startTui(events),
    })
  },
}

export default plugin
