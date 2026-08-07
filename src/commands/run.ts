import { getCommand } from "./registry"
import type { CommandContext } from "./types"

export async function runCommand(line: string, ctx: CommandContext): Promise<void> {
  const [name, ...args] = line.slice(1).trim().split(/\s+/).filter(Boolean)
  if (!name) return

  const command = getCommand(name)
  if (!command) throw new Error(`unknown command: /${name}`)

  await command.run(args, ctx)
}
