import { getProvider } from "../providers/registry"
import { registerCommand } from "./registry"

registerCommand({
  name: "models",
  hidden: true,
  describe: "list available models for a provider",
  async run(args, ctx) {
    const provider = getProvider(args[0] ?? "chatgpt")
    if (!provider) throw new Error(`unknown provider: ${args[0]}`)
    const [models, defaultId] = await Promise.all([provider.listModels(), provider.defaultModel()])
    for (const model of models) {
      const marker = model.id === defaultId ? "*" : " "
      const context = model.contextWindow ? `  ${Math.round(model.contextWindow / 1000)}k ctx` : ""
      ctx.print(`${marker} ${model.id.padEnd(28)} ${model.name}${context}`)
    }
  },
})
