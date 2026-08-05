import { appInfo } from "../../app-info"
import type { Command } from "../../commands/registry"
import { getProvider, listProviders } from "../../providers/registry"

export const loginCommand: Command = {
  name: "login",
  usage: "login chatgpt",
  describe: "sign in to a provider",
  async run(args, ctx) {
    const available = listProviders().flatMap((provider) => provider.aliases)
    const alias = args[0]
    if (!alias) {
      throw new Error(`usage: ${appInfo.name} login <provider>  (available: ${available.join(", ")})`)
    }
    const provider = getProvider(alias)
    if (!provider) {
      throw new Error(`unknown provider: ${alias}  (available: ${available.join(", ")})`)
    }
    await provider.login(ctx.print)
  },
}
