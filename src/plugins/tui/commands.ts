import { appInfo } from "../../app-info"
import type { Command } from "../../commands/types"
import type { PluginContext } from "../types"

interface TuiCommandActions {
  config(): void
  terminal(): string[]
  quit(): void
}

let actions: TuiCommandActions | undefined

export function setTuiCommandActions(next: TuiCommandActions): () => void {
  actions = next
  return () => {
    if (actions === next) actions = undefined
  }
}

const terminalCommand: Command = {
  name: "terminal",
  describe: "show detected terminal capabilities",
  async run(_args, ctx) {
    if (!actions) throw new Error("tui is not running")
    for (const line of actions.terminal()) ctx.print(line)
  },
}

const configCommand: Command = {
  name: "config",
  describe: "configure persistent display preferences",
  async run() {
    if (!actions) throw new Error("tui is not running")
    actions.config()
  },
}

async function exitTui(): Promise<void> {
  if (!actions) throw new Error("tui is not running")
  actions.quit()
}

const quitCommand: Command = {
  name: "quit",
  describe: `exit ${appInfo.name}`,
  run: exitTui,
}

const exitCommand: Command = {
  name: "exit",
  describe: `exit ${appInfo.name}`,
  run: exitTui,
}

export function registerTuiCommands(ctx: PluginContext): void {
  ctx.registerCommand(configCommand)
  ctx.registerCommand(terminalCommand)
  ctx.registerCommand(quitCommand)
  ctx.registerCommand(exitCommand)
}
