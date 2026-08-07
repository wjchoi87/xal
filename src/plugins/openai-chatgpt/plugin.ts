import type { Plugin } from "../types"
import { openaiChatgptProvider } from "./provider"

const plugin: Plugin = {
  name: "openai-chatgpt",
  register(ctx) {
    ctx.registerProvider(openaiChatgptProvider)
  },
}

export default plugin
