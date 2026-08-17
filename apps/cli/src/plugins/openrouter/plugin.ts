import { configuredClientIdentity } from "../../providers/identity"
import type { Plugin } from "../types"
import { setClientIdentity } from "./api"
import { openRouterProvider } from "./provider"

const plugin: Plugin = {
  name: "openrouter",
  register(ctx) {
    setClientIdentity(configuredClientIdentity("openrouter", ctx.config))
    ctx.registerProvider(openRouterProvider)
  },
}

export default plugin
