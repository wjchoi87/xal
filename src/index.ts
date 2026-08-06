import { appInfo } from "./app-info"
import { getCli, listClis, type CliContext } from "./cli/registry"
import { loadSettings } from "./config/settings"
import { bootstrapPlugins, registerPlugins } from "./plugins/discover"
import { getUi } from "./ui/registry"

const ctx: CliContext = {
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
  for (const cli of listClis()) {
    if (cli.hidden) continue
    ctx.print(`  ${(appInfo.name + " " + (cli.usage ?? cli.name)).padEnd(24)}${cli.describe}`)
  }
}

async function main(args: string[]): Promise<void> {
  const settings = await loadSettings()
  const plugins = await registerPlugins(settings)

  if (args.length === 0) {
    const uiId = settings.ui ?? "tui"
    const ui = getUi(uiId)
    if (!ui) {
      ctx.print(`unknown ui: ${uiId}`)
      process.exit(1)
    }
    void bootstrapPlugins()
    await ui.start()
    return
  }

  for (const failure of plugins.failures) {
    ctx.print(`plugin failed: ${failure.plugin}: ${failure.reason}`)
  }

  const bootstrapped = await bootstrapPlugins()
  for (const failure of bootstrapped.failures) {
    if (failure.phase !== "bootstrap") continue
    ctx.print(`plugin bootstrap failed: ${failure.plugin}: ${failure.reason}`)
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

  const cli = getCli(first)
  if (!cli) {
    ctx.print(`unknown command: ${first}`)
    printHelp()
    process.exit(1)
  }

  try {
    await cli.run(args.slice(1), ctx)
  } catch (error) {
    ctx.print(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}

await main(process.argv.slice(2))
