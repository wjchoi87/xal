import { builtinCommands } from "./builtins"
import type { Command } from "./types"

const commands = new Map<string, Command>(builtinCommands.map((command) => [command.name, command]))

export function registerCommand(command: Command): void {
  commands.set(command.name, command)
}

export function listCommands(): Command[] {
  return [...commands.values()]
}

export function getCommand(name: string): Command | undefined {
  return commands.get(name)
}
