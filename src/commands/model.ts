import { saveSettings } from "../config/settings"
import { resolveThinking } from "../config/thinking"
import { listModelChoices } from "../providers/catalog"
import type { Command } from "./types"

export const modelCommand: Command = {
  name: "model",
  describe: "choose the model for this and future sessions",
  async run(_args, ctx) {
    if (ctx.session.currentState !== "idle") {
      ctx.print("cannot change model while a turn is running")
      return
    }

    ctx.busy("Loading models")
    const choices = await listModelChoices()
    ctx.busy()
    if (choices.length === 0) throw new Error("no models available — run /connect first")

    while (true) {
      const currentProvider = ctx.session.currentProvider
      const currentModel = ctx.session.currentModel
      const choice = await ctx.select({
        options: choices.map((choice) => {
          const current = choice.provider === currentProvider && choice.model.id === currentModel
          return {
            label: choice.model.id,
            detail: choice.provider.name,
            note: current ? "current" : undefined,
            active: current,
            value: choice,
          }
        }),
      })
      if (!choice) return
      if (choice.provider === currentProvider && choice.model.id === currentModel) return

      if (ctx.session.hasModelOutput) {
        ctx.print(
          `Switch model? History will carry forward, but ${choice.model.id} may need to re-read it without ${currentModel}'s prompt cache. The next response may be slower and use more input tokens.`,
        )
        const confirmed = await ctx.select({
          options: [
            {
              label: `Yes, switch to ${choice.model.id}`,
              detail: choice.provider.name,
              active: true,
              value: true,
            },
            { label: "No, go back", detail: `keep ${currentModel}`, value: false },
          ],
        })
        if (confirmed === undefined) return
        if (!confirmed) continue
      }

      const thinking = await resolveThinking(choice.provider, choice.model.id)
      if (!ctx.session.setModel(choice.provider, choice.model.id, thinking)) {
        ctx.print("cannot change model while a turn is running")
        return
      }
      await saveSettings({ provider: choice.provider.id, model: choice.model.id })
      return
    }
  },
}
