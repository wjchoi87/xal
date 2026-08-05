import { appInfo } from "./app-info"
import { getCommand, listCommands, type CommandContext } from "./commands/registry"
import "./commands/register-all"

const ctx: CommandContext = {
  print(line) {
    console.log(line)
  },
}

function printHelp(): void {
  ctx.print(`${appInfo.name} v${appInfo.version}`)
  ctx.print("")
  ctx.print(`usage: ${appInfo.name} [command]`)
  ctx.print("")
  ctx.print(`  ${appInfo.name.padEnd(24)}start the chat TUI`)
  for (const command of listCommands()) {
    if (command.hidden) continue
    ctx.print(`  ${(appInfo.name + " " + (command.usage ?? command.name)).padEnd(24)}${command.describe}`)
  }
}

async function main(args: string[]): Promise<void> {
  if (args.length === 0) {
    const { startTui } = await import("./tui/app")
    await startTui()
    return
  }

  const first = args[0]!
  if (first === "--version" || first === "-v" || first === "version") {
    ctx.print(`${appInfo.name} ${appInfo.version}`)
    return
  }
  if (first === "--help" || first === "-h" || first === "help") {
    printHelp()
    return
  }

  const command = getCommand(first)
  if (!command) {
    ctx.print(`unknown command: ${first}`)
    printHelp()
    process.exit(1)
  }

  try {
    await command.run(args.slice(1), ctx)
  } catch (error) {
    ctx.print(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}

await main(process.argv.slice(2))
