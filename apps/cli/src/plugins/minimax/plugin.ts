import { configuredClientIdentity } from "../../providers/identity"
import type { Plugin } from "../types"
import { setClientIdentity } from "./api"
import { miniMaxCodingPlanProvider, miniMaxProvider } from "./provider"

const plugin: Plugin = {
  name: "minimax",
  register(ctx) {
    setClientIdentity(configuredClientIdentity("minimax", ctx.config))
    ctx.registerProvider(miniMaxProvider)
    ctx.registerProvider(miniMaxCodingPlanProvider)
  },
}

export default plugin
