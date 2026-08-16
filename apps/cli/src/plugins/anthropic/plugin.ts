import { configuredClientIdentity } from "../../providers/identity"
import type { Plugin } from "../types"
import { setClientIdentity } from "./api"
import { anthropicProvider } from "./provider"

const plugin: Plugin = {
  name: "anthropic",
  register(ctx) {
    setClientIdentity(configuredClientIdentity("anthropic", ctx.config))
    ctx.registerProvider(anthropicProvider)
  },
}

export default plugin
