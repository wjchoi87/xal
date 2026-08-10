import { registerCommand } from "../commands/registry"
import type { Command } from "../commands/types"
import { saveSettings } from "../config/settings"
import { resolveThinking, saveThinking, thinkingOptions } from "../config/thinking"
import { listConnectTargets, listModelChoices, modelCatalog, modelSummary } from "./catalog"
import type { ThinkingEffort } from "./types"

const connectCommand: Command = {
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
    const catalog = await modelCatalog(target.provider, true)
    if (catalog.warning) ctx.print(`model catalog · ${target.provider.name}: ${catalog.warning}`)
    const modelInfo = catalog.models.find((info) => info.id === model)
    const thinking = await resolveThinking(target.provider, model)
    if (!ctx.session.setModel(target.provider, model, thinking, modelInfo?.inputModalities)) {
      ctx.print("cannot change provider while a turn is running")
      return
    }
    await saveSettings({ provider: target.provider.id, model })
  },
}

const modelCommand: Command = {
  name: "model",
  describe: "choose the model for this and future sessions",
  async run(_args, ctx) {
    if (ctx.session.currentState !== "idle") {
      ctx.print("cannot change model while a turn is running")
      return
    }

    ctx.busy("Discovering models")
    const result = await listModelChoices(true).finally(() => ctx.busy())
    const { choices, notices } = result
    for (const notice of notices) ctx.print(`model catalog · ${notice.provider.name}: ${notice.message}`)
    if (choices.length === 0) throw new Error("no models available — run /connect first")

    while (true) {
      const currentProvider = ctx.session.currentProvider
      const currentModel = ctx.session.currentModel
      const choice = await ctx.select({
        options: choices.map((choice) => {
          const current = choice.provider === currentProvider && choice.model.id === currentModel
          const summary = modelSummary(choice.model)
          const source = choice.source === "runtime" ? "" : ` · ${choice.source}`
          return {
            label: choice.model.id,
            detail: `${choice.provider.aliases[0] ?? choice.provider.id}${summary ? ` · ${summary}` : ""}${source}`,
            note: current ? "current" : undefined,
            active: current,
            value: choice,
          }
        }),
      })
      if (!choice) return
      if (choice.provider === currentProvider && choice.model.id === currentModel) {
        const thinking = await resolveThinking(choice.provider, choice.model.id, ctx.session.currentThinking)
        ctx.session.setModel(choice.provider, choice.model.id, thinking, choice.model.inputModalities)
        return
      }

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
      if (!ctx.session.setModel(choice.provider, choice.model.id, thinking, choice.model.inputModalities)) {
        ctx.print("cannot change model while a turn is running")
        return
      }
      await saveSettings({ provider: choice.provider.id, model: choice.model.id })
      return
    }
  },
}

const thinkingLabels: Record<ThinkingEffort, string> = {
  none: "Off",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "XHigh",
  max: "Max",
}

const thinkingCommand: Command = {
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
        label: thinkingLabels[effort],
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

export function registerProviderCommands(): void {
  registerCommand(connectCommand)
  registerCommand(modelCommand)
  registerCommand(thinkingCommand)
}
