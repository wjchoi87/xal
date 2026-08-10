import type { Plugin } from "../types"
import { runCli } from "./cli"

const plugin: Plugin = {
  name: "headless",
  register(ctx) {
    ctx.registerCli(runCli)
  },
}

export default plugin
