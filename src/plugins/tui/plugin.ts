import type { Plugin } from "../types"

const plugin: Plugin = {
  name: "tui",
  register(ctx) {
    ctx.registerUi({
      id: "tui",
      start: async () => (await import("./app")).startTui(),
    })
  },
}

export default plugin
