import { configuredClientIdentity } from "../../providers/identity"
import type { Plugin } from "../types"
import { setClientIdentity } from "./api"
import { deepSeekProvider } from "./provider"

const plugin: Plugin = {
  name: "deepseek",
  register(ctx) {
    setClientIdentity(configuredClientIdentity("deepseek", ctx.config))
    ctx.registerProvider(deepSeekProvider)
  },
}

export default plugin
