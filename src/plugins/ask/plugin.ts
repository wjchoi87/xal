import type { Plugin } from "../types"
import { askCli } from "./cli"

const plugin: Plugin = {
  name: "ask",
  register(ctx) {
    ctx.registerCli(askCli)
  },
}

export default plugin
