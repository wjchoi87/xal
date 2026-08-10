import type { Command } from "../../commands/types"
import { listHooks } from "../../hooks/registry"
import type { Plugin } from "../types"

const hooksCommand: Command = {
  name: "hooks",
  describe: "show registered lifecycle hooks",
  async run(_args, ctx) {
    const hooks = listHooks()
    if (hooks.length === 0) {
      ctx.print("No hooks registered.")
      return
    }
    for (const hook of hooks) ctx.print(`${hook.id} · ${hook.events.join(", ")}`)
  },
}

const plugin: Plugin = {
  name: "hooks",
  register(ctx) {
    ctx.registerCommand(hooksCommand)
  },
}

export default plugin
