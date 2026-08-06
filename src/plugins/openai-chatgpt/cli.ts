import type { Cli } from "../../cli/types"
import { defaultModel, listModels } from "./models"
import { login } from "./oauth"

export const connectCli: Cli = {
  name: "chatgpt",
  describe: "sign in with a ChatGPT subscription",
  async run(args, ctx) {
    await login(ctx.print)
  },
}

export const modelsCli: Cli = {
  name: "chatgpt",
  describe: "list ChatGPT models",
  async run(args, ctx) {
    const [models, defaultId] = await Promise.all([listModels(), defaultModel()])
    for (const model of models) {
      const marker = model.id === defaultId ? "*" : " "
      const context = model.contextWindow ? `  ${Math.round(model.contextWindow / 1000)}k ctx` : ""
      ctx.print(`${marker} ${model.id.padEnd(28)} ${model.name}${context}`)
    }
  },
}
