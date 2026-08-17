import { asString } from "../../lib/json"
import { configuredClientIdentity } from "../../providers/identity"
import type { Plugin } from "../types"
import { setBaseUrl, setClientIdentity } from "./api"
import { xaiProvider } from "./provider"

function baseUrl(config: Record<string, unknown>): string {
  const configured = asString(config.baseUrl)?.trim()
  if ("baseUrl" in config && !configured) throw new Error("xai baseUrl must be a non-empty URL")
  const value = configured ?? "https://api.x.ai/v1"
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error("xai baseUrl must be a valid URL")
  }
  if (url.protocol !== "https:") throw new Error("xai baseUrl must use HTTPS")
  return value.replace(/\/+$/, "")
}

const plugin: Plugin = {
  name: "xai",
  register(ctx) {
    setBaseUrl(baseUrl(ctx.config))
    setClientIdentity(configuredClientIdentity("xai", ctx.config))
    ctx.registerProvider(xaiProvider)
  },
}

export default plugin
