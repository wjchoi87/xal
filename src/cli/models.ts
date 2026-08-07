import { appInfo } from "../app-info"
import { settings } from "../config/settings"
import { listModelChoices } from "../providers/catalog"
import { getProvider } from "../providers/registry"
import type { Provider } from "../providers/types"
import type { Cli } from "./types"

export const modelsCli: Cli = {
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
