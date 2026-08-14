import type { Command } from "./types"

const commands = new Map<string, Command>()
const aliases = new Map<string, Command>()

export function registerCommand(command: Command): void {
  const names = [command.name, ...(command.aliases ?? [])]
  const conflict = names.find((name, index) => names.indexOf(name) !== index || commands.has(name) || aliases.has(name))
  if (conflict) throw new Error(`command already registered: /${conflict}`)

  commands.set(command.name, command)
  for (const alias of command.aliases ?? []) aliases.set(alias, command)
}

export function listCommands(): Command[] {
  return [...commands.values()]
}

export function getCommand(name: string): Command | undefined {
  return commands.get(name) ?? aliases.get(name)
}
