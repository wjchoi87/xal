import type { Plugin } from "../types"
import { askCli } from "./ask"
import { loginCli } from "./login"
import { modelsCli } from "./models"

const plugin: Plugin = {
  name: "cli",
  register(ctx) {
    ctx.registerCli(loginCli)
    ctx.registerCli(modelsCli)
    ctx.registerCli(askCli)
  },
}

export default plugin
