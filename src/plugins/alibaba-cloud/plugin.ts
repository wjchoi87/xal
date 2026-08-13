import { asString } from "../../lib/json"
import { configuredClientIdentity } from "../../providers/identity"
import type { Plugin } from "../types"
import { setBaseUrl, setClientIdentity } from "./api"
import { alibabaCloudProvider } from "./provider"

function baseUrl(config: Record<string, unknown>): string {
  const configured = asString(config.baseUrl)?.trim()
  if ("baseUrl" in config && !configured) throw new Error("alibaba-cloud baseUrl must be a non-empty URL")
  const value = configured ?? "https://dashscope-intl.aliyuncs.com/compatible-mode/v1"
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error("alibaba-cloud baseUrl must be a valid URL")
  }
  if (url.protocol !== "https:") throw new Error("alibaba-cloud baseUrl must use HTTPS")
  return value.replace(/\/+$/, "")
}

const plugin: Plugin = {
  name: "alibaba-cloud",
  register(ctx) {
    setBaseUrl(baseUrl(ctx.config))
    setClientIdentity(configuredClientIdentity("alibaba-cloud", ctx.config))
    ctx.registerProvider(alibabaCloudProvider)
  },
}

export default plugin
