import type { Plugin } from "../types"
import { connectCli, modelsCli } from "./cli"
import { openaiChatgptProvider } from "./provider"

const plugin: Plugin = {
  name: "openai-chatgpt",
  register(ctx) {
    ctx.registerProvider(openaiChatgptProvider)
    ctx.registerCli(connectCli, "connect")
    ctx.registerCli(modelsCli, "models")
  },
}

export default plugin
