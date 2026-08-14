import { appInfo } from "../app-info"
import { chooseOption } from "../cli/choose"
import { registerCli } from "../cli/registry"
import type { Cli } from "../cli/types"
import { settings } from "../config/settings"
import { listConnectTargets, listModelChoices, modelSummary } from "./catalog"
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
      select: (choices) => chooseOption(choices.map((choice) => `${choice.label} — ${choice.detail}`)),
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

    const catalog = await listModelChoices(true)
    const choices = catalog.choices.filter((choice) => !only || choice.provider === only)
    for (const notice of catalog.notices) {
      if (!only || notice.provider === only) ctx.error(`warning: ${notice.provider.name}: ${notice.message}`)
    }
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
      const summary = modelSummary(model, true)
      ctx.print(`${marker} ${model.id.padEnd(28)} ${model.name}${summary ? `  · ${summary}` : ""}`)
    }
  },
}

export function registerProviderClis(): void {
  registerCli(connectCli)
  registerCli(modelsCli)
}
