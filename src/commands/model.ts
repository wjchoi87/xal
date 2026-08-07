import { saveSettings } from "../config/settings"
import { listModelChoices } from "../providers/catalog"
import type { Command } from "./types"

export const modelCommand: Command = {
  name: "model",
  describe: "choose the model for this and future sessions",
  async run(_args, ctx) {
    ctx.busy("Loading models")
    const choices = await listModelChoices()
    ctx.busy()
    if (choices.length === 0) throw new Error("no models available — run /connect first")

    const current = ctx.session.currentModel
    const choice = await ctx.select({
      options: choices.map((choice) => ({
        label: choice.model.id,
        detail: choice.provider.name,
        note: choice.model.id === current ? "current" : undefined,
        active: choice.model.id === current,
        value: choice,
      })),
    })
    if (!choice) return

    ctx.session.setModel(choice.provider, choice.model.id)
    await saveSettings({ provider: choice.provider.id, model: choice.model.id })
  },
}
