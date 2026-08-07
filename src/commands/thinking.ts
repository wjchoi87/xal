import { saveThinking, thinkingOptions } from "../config/thinking"
import type { ThinkingEffort } from "../providers/types"
import type { Command } from "./types"

const labels: Record<ThinkingEffort, string> = {
  none: "Off",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "XHigh",
  max: "Max",
}

export const thinkingCommand: Command = {
  name: "thinking",
  describe: "choose thinking effort for the current model",
  async run(_args, ctx) {
    if (ctx.session.currentState !== "idle") {
      ctx.print("cannot change thinking while a turn is running")
      return
    }

    const provider = ctx.session.currentProvider
    const model = ctx.session.currentModel
    const available = await thinkingOptions(provider, model)
    if (!available) {
      ctx.print(`${model} does not support configurable thinking`)
      return
    }

    const selected = await ctx.select({
      options: available.options.map((effort) => ({
        label: labels[effort],
        detail: effort === "none" ? "disable reasoning" : `${effort} reasoning effort`,
        note: effort === ctx.session.currentThinking ? "current" : undefined,
        active: effort === ctx.session.currentThinking,
        value: effort,
      })),
    })
    if (!selected || selected === ctx.session.currentThinking) return
    if (!ctx.session.setThinking(selected)) {
      ctx.print("cannot change thinking while a turn is running")
      return
    }
    await saveThinking(provider, model, selected)
  },
}
