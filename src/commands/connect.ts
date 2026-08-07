import { saveSettings } from "../config/settings"
import { resolveThinking } from "../config/thinking"
import { listConnectTargets } from "../providers/catalog"
import type { Command } from "./types"

export const connectCommand: Command = {
  name: "connect",
  describe: "sign in to a provider",
  async run(_args, ctx) {
    const targets = await listConnectTargets()
    if (targets.length === 0) throw new Error("no provider supports signing in")

    const target = await ctx.select({
      options: targets.map((target) => ({
        label: target.provider.aliases[0] ?? target.provider.id,
        detail: target.provider.name,
        note: target.connected ? "connected" : undefined,
        value: target,
      })),
    })
    if (!target) return

    const connected = await target.provider.connect?.({
      print: (line) => ctx.print(line),
      askSecret: (question) => ctx.askSecret(question),
    })
    if (!connected) return
    const model = await target.provider.defaultModel()
    const thinking = await resolveThinking(target.provider, model)
    if (!ctx.session.setModel(target.provider, model, thinking)) {
      ctx.print("cannot change provider while a turn is running")
      return
    }
    await saveSettings({ provider: target.provider.id, model })
  },
}
