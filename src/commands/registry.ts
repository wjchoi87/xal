export interface CommandContext {
  print(line: string): void
}

export interface Command {
  name: string
  describe: string
  usage?: string
  hidden?: boolean
  run(args: string[], ctx: CommandContext): Promise<void>
}

const commands = new Map<string, Command>()

export function registerCommand(command: Command): void {
  commands.set(command.name, command)
}

export function getCommand(name: string): Command | undefined {
  return commands.get(name)
}

export function listCommands(): Command[] {
  return [...commands.values()]
}
