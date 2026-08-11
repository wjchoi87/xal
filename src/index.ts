import { registerAgentCommands } from "./agent/commands"
import { chooseOption } from "./cli/choose"
import { runCli } from "./cli/run"
import { askSecret } from "./cli/secret"
import type { CliContext } from "./cli/types"
import { loadCredentialSecrets } from "./config/credentials"
import { loadSettings } from "./config/settings"
import { describeError } from "./lib/error"
import { bootstrapPlugins, registerPlugins } from "./plugins/discover"
import { startProfiler, stopProfiler } from "./profiler/profiler"
import { registerTrustClis } from "./project/cli"
import { ensureWorkspaceTrust } from "./project/trust"
import { registerProviderClis } from "./providers/cli"
import { registerProviderCommands } from "./providers/commands"
import { registerSessionClis } from "./sessions/cli"
import { registerSessionCommands } from "./sessions/commands"
import { protectSecretValue, redactText } from "./secrets/redactor"
import { getUi } from "./ui/registry"

const ctx: CliContext = {
  print(line) {
    console.log(redactText(line))
  },
  error(line) {
    console.error(redactText(line))
  },
  ask(question) {
    return Promise.resolve(prompt(redactText(question)) ?? "")
  },
  async askSecret(question) {
    const value = await askSecret(redactText(question))
    if (value !== undefined) protectSecretValue(value)
    return value
  },
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
  startProfiler()
  const args = normalize(input)
  const trusted = await ensureWorkspaceTrust({
    print: args.length === 0 ? ctx.print : ctx.error,
    choose: args.length === 0 && process.stdin.isTTY ? chooseOption : undefined,
  })
  if (!trusted) return
  const settings = await loadSettings()
  await loadCredentialSecrets()
  registerCore()
  const plugins = await registerPlugins(settings)

  if (args.length === 0) {
    const uiId = settings.ui ?? "tui"
    const ui = getUi(uiId)
    if (!ui) {
      ctx.error(`unknown ui: ${uiId}`)
      process.exitCode = 1
      return
    }
    void bootstrapPlugins()
    await ui.start()
    return
  }

  for (const failure of plugins.failures) {
    ctx.error(`plugin failed: ${failure.plugin}: ${failure.reason}`)
  }

  const bootstrapped = await bootstrapPlugins()
  for (const failure of bootstrapped.failures) {
    if (failure.phase !== "bootstrap") continue
    ctx.error(`plugin bootstrap failed: ${failure.plugin}: ${failure.reason}`)
  }

  await runCli(args, ctx)
}

try {
  await main(process.argv.slice(2))
} catch (error) {
  console.error(redactText(describeError(error)))
  process.exitCode = 1
}
const profile = await stopProfiler()
if (profile) console.error(`profile: ${profile}`)
await Promise.all([
  new Promise<void>((resolve) => process.stdout.write("", () => resolve())),
  new Promise<void>((resolve) => process.stderr.write("", () => resolve())),
])
process.exit(process.exitCode ?? 0)
