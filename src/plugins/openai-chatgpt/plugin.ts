import { asNumber } from "../../lib/json"
import type { Plugin } from "../types"
import { setContextWindowCap } from "./models"
import { openaiChatgptProvider } from "./provider"

function contextWindowCap(config: Record<string, unknown>): number | undefined {
  if (!("contextWindow" in config)) return undefined
  const configured = asNumber(config.contextWindow)
  if (configured === undefined || !Number.isInteger(configured) || configured <= 0) {
    throw new Error("openai-chatgpt contextWindow must be a positive integer")
  }
  return configured
}

const plugin: Plugin = {
  name: "openai-chatgpt",
  register(ctx) {
    setContextWindowCap(contextWindowCap(ctx.config))
    ctx.registerProvider(openaiChatgptProvider)
  },
}

export default plugin
