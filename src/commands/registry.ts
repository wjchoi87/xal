import type { Command } from "./types"

const commands = new Map<string, Command>()

export function registerCommand(command: Command): void {
  if (commands.has(command.name)) throw new Error(`command already registered: /${command.name}`)
  commands.set(command.name, command)
}

export function listCommands(): Command[] {
  return [...commands.values()]
}

export function getCommand(name: string): Command | undefined {
  return commands.get(name)
}
