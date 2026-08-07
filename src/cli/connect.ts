import { appInfo } from "../app-info"
import { listConnectTargets } from "../providers/catalog"
import { getProvider } from "../providers/registry"
import type { Cli } from "./types"

export const connectCli: Cli = {
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
      ask: async (question) => prompt(question) ?? "",
    })
  },
}
