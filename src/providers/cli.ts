import { appInfo } from "../app-info"
import { registerCli } from "../cli/registry"
import type { Cli } from "../cli/types"
import { settings } from "../config/settings"
import { listConnectTargets, listModelChoices } from "./catalog"
import { getProvider } from "./registry"
import type { Provider } from "./types"

const connectCli: Cli = {
  name: "connect",
  usage: "connect <provider>",
  describe: "sign in to a provider",
  async run(args, ctx) {
    const wanted = args[0]
    if (!wanted) {
      const targets = await listConnectTargets()
      if (targets.length === 0) throw new Error("no provider supports signing in")
      ctx.print(`usage: ${appInfo.name} connect <provider>`)
      ctx.print("")
      for (const target of targets) {
        const alias = target.provider.aliases[0] ?? target.provider.id
        ctx.print(`  ${alias.padEnd(20)}${target.provider.name}${target.connected ? "  · connected" : ""}`)
      }
      return
    }

    const provider = getProvider(wanted)
    if (!provider) throw new Error(`unknown provider: ${wanted}`)
    if (!provider.connect) throw new Error(`${provider.name} does not support signing in`)

    await provider.connect({
      print: (line) => ctx.print(line),
      ask: (question) => ctx.ask(question),
      askSecret: (question) => ctx.askSecret(question),
    })
  },
}

const modelsCli: Cli = {
  name: "models",
  usage: "models [provider]",
  describe: "list available models",
  async run(args, ctx) {
    const wanted = args[0]
    const only = wanted ? getProvider(wanted) : undefined
    if (wanted && !only) throw new Error(`unknown provider: ${wanted}`)

    const choices = (await listModelChoices()).filter((choice) => !only || choice.provider === only)
    if (choices.length === 0) {
      ctx.print(`no models available — run: ${appInfo.name} connect`)
      return
    }

    const providers = [...new Set(choices.map((choice) => choice.provider))]
    const defaults = new Map<string, string>()
    await Promise.all(
      providers.map(async (provider) => {
        defaults.set(provider.id, await provider.defaultModel().catch(() => ""))
      }),
    )

    const active = settings().model
    let group: Provider | undefined
    for (const { provider, model } of choices) {
      if (providers.length > 1 && provider !== group) {
        if (group) ctx.print("")
        ctx.print(provider.name)
      }
      group = provider
      const marker = (active ?? defaults.get(provider.id)) === model.id ? "*" : " "
      const context = model.contextWindow ? `  ${Math.round(model.contextWindow / 1000)}k ctx` : ""
      ctx.print(`${marker} ${model.id.padEnd(28)} ${model.name}${context}`)
    }
  },
}

export function registerProviderClis(): void {
  registerCli(connectCli)
  registerCli(modelsCli)
}
