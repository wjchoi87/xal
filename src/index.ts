import { runCli } from "./cli/run"
import type { CliContext } from "./cli/types"
import { loadSettings } from "./config/settings"
import { bootstrapPlugins, registerPlugins } from "./plugins/discover"
import { getUi } from "./ui/registry"

const ctx: CliContext = {
  print(line) {
    console.log(line)
  },
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

  await runCli(args, ctx)
}

await main(process.argv.slice(2))
