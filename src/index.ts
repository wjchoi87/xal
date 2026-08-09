import { registerAgentCommands } from "./agent/commands"
import { chooseOption } from "./cli/choose"
import { runCli } from "./cli/run"
import { askSecret } from "./cli/secret"
import type { CliContext } from "./cli/types"
import { loadSettings } from "./config/settings"
import { bootstrapPlugins, registerPlugins } from "./plugins/discover"
import { registerTrustClis } from "./project/cli"
import { ensureWorkspaceTrust } from "./project/trust"
import { registerProviderClis } from "./providers/cli"
import { registerProviderCommands } from "./providers/commands"
import { registerSessionClis } from "./sessions/cli"
import { registerSessionCommands } from "./sessions/commands"
import { getUi } from "./ui/registry"

const ctx: CliContext = {
  print(line) {
    console.log(line)
  },
  ask(question) {
    return Promise.resolve(prompt(question) ?? "")
  },
  askSecret,
}

function registerCore(): void {
  registerProviderCommands()
  registerProviderClis()
  registerAgentCommands()
  registerSessionCommands()
  registerSessionClis()
  registerTrustClis()
}

function normalize(args: string[]): string[] {
  const first = args[0]
  if (first === "-c" || first === "--continue") return ["resume", ...args.slice(1)]
  return args
}

async function main(input: string[]): Promise<void> {
  const args = normalize(input)
  const trusted = await ensureWorkspaceTrust({
    print: ctx.print,
    choose: args.length === 0 && process.stdin.isTTY ? chooseOption : undefined,
  })
  if (!trusted) return
  const settings = await loadSettings()
  registerCore()
  const plugins = await registerPlugins(settings)

  if (args.length === 0) {
    const uiId = settings.ui ?? "tui"
    const ui = getUi(uiId)
    if (!ui) {
      ctx.print(`unknown ui: ${uiId}`)
      process.exitCode = 1
      return
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
process.exit(process.exitCode ?? 0)
