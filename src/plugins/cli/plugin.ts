import type { Plugin } from "../types"
import { askCommand } from "./ask"
import { loginCommand } from "./login"
import { modelsCommand } from "./models"

const plugin: Plugin = {
  name: "cli",
  register(ctx) {
    ctx.registerCommand(loginCommand)
    ctx.registerCommand(modelsCommand)
    ctx.registerCommand(askCommand)
  },
}

export default plugin
