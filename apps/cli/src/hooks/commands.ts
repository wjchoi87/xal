import { registerCommand } from "../commands/registry"
import type { Command } from "../commands/types"
import { listHooks } from "./registry"

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

export function registerHookCommands(): void {
  registerCommand(hooksCommand)
}
