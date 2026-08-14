import { registerBasePrompt } from "./agent/base-prompt"
import { registerAgentClis } from "./agent/cli"
import { registerAgentCommands } from "./agent/commands"
import { registerTaskAgents } from "./agent/sub-agent"
import { registerJobTools } from "./background/register"
import { chooseOption } from "./cli/choose"
import { runCli } from "./cli/run"
import { askSecret } from "./cli/secret"
import type { CliContext } from "./cli/types"
import { loadCredentialSecrets } from "./config/credentials"
import { loadSettings, type Settings } from "./config/settings"
import { registerWorktreeTools } from "./git/worktree-tools"
import { registerHookCommands } from "./hooks/commands"
import { describeError } from "./lib/error"
import { registerPermissions } from "./permissions/register"
import { registerPlans } from "./plans/register"
import { bootstrapPlugins, registerBootstrapStep, registerPlugins, shutdownPlugins } from "./plugins/discover"
import { startProfiler, stopProfiler } from "./profiler/profiler"
import { registerTrustClis } from "./project/cli"
import { ensureWorkspaceTrust } from "./project/trust"
import { registerProviderClis } from "./providers/cli"
import { registerProviderCommands } from "./providers/commands"
import { registerSessionClis } from "./sessions/cli"
import { registerSessionCommands } from "./sessions/commands"
import { protectSecretValue, redactText } from "./secrets/redactor"
import { registerRedaction } from "./secrets/register"
import { discoverSkills, registerSkills } from "./skills/register"
import { registerTasks } from "./tasks/register"
import { registerBash } from "./tools/bash/register"
import { getUi } from "./ui/registry"

const ctx: CliContext = {
  print(line) {
    console.log(redactText(line))
  },
  error(line) {
    console.error(redactText(line))
  },
  async askSecret(question) {
    const value = await askSecret(redactText(question))
    if (value !== undefined) protectSecretValue(value)
    return value
  },
}

let terminationRequested = false

function registerCore(settings: Settings): void {
  registerPermissions(settings)
  registerRedaction(settings)
  registerBasePrompt()
  registerPlans()
  registerTasks()
  registerSkills()
  registerBootstrapStep("skills", discoverSkills)
  registerBash()
  registerJobTools()
  registerWorktreeTools()
  registerTaskAgents()
  registerProviderCommands()
  registerProviderClis()
  registerAgentCommands()
  registerAgentClis()
  registerHookCommands()
  registerSessionCommands()
  registerSessionClis()
  registerTrustClis()
}

function parseGlobalOptions(input: string[]): { profile: boolean; args: string[] } {
  let profile = false
  let index = 0
  while (input[index]?.startsWith("-")) {
    const option = input[index]!
    if (option !== "--profile") break
    if (profile) throw new Error("duplicate option: --profile")
    profile = true
    index++
  }
  return { profile, args: input.slice(index) }
}

function normalize(args: string[]): string[] {
  const first = args[0]
  if (first === "-c" || first === "--continue") return ["resume", ...args.slice(1)]
  return args
}

async function main(input: string[]): Promise<void> {
  const options = parseGlobalOptions(input)
  startProfiler(options.profile)
  const args = normalize(options.args)
  const trusted = await ensureWorkspaceTrust({
    print: args.length === 0 ? ctx.print : ctx.error,
    choose: args.length === 0 && process.stdin.isTTY ? chooseOption : undefined,
  })
  if (!trusted) return
  const settings = await loadSettings()
  await loadCredentialSecrets()
  registerCore(settings)
  const plugins = await registerPlugins(settings)
  if (terminationRequested) return

  if (args.length === 0) {
    const uiId = settings.ui ?? "tui"
    const ui = getUi(uiId)
    if (!ui) {
      for (const failure of plugins.failures) {
        ctx.error(`plugin failed: ${failure.plugin}: ${failure.reason}`)
      }
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
  if (terminationRequested) return
  for (const failure of bootstrapped.failures) {
    if (failure.phase !== "bootstrap") continue
    ctx.error(`plugin bootstrap failed: ${failure.plugin}: ${failure.reason}`)
  }

  await runCli(args, ctx)
}

let exitRun: Promise<never> | undefined

function finish(): Promise<never> {
  exitRun ??= (async () => {
    const stopped = await shutdownPlugins()
    for (const failure of stopped.failures) {
      if (failure.phase !== "shutdown") continue
      console.error(redactText(`plugin shutdown failed: ${failure.plugin}: ${failure.reason}`))
      if (process.exitCode === undefined || process.exitCode === 0) process.exitCode = 1
    }
    const profile = await stopProfiler()
    if (profile) console.error(`profile: ${profile}`)
    await Promise.all([
      new Promise<void>((resolve) => process.stdout.write("", () => resolve())),
      new Promise<void>((resolve) => process.stderr.write("", () => resolve())),
    ])
    process.exit(process.exitCode ?? 0)
  })()
  return exitRun
}

function terminate(code: number): void {
  terminationRequested = true
  if (process.exitCode === undefined || process.exitCode === 0) process.exitCode = code
  setTimeout(() => process.exit(code), 7_000).unref()
  void finish()
}

process.once("SIGTERM", () => terminate(143))
process.once("SIGHUP", () => terminate(129))
process.on("SIGINT", () => {
  if (process.listenerCount("SIGINT") > 1) return
  terminate(130)
})

try {
  await main(process.argv.slice(2))
} catch (error) {
  console.error(redactText(describeError(error)))
  process.exitCode = 1
}
await finish()
