import { configuredClientIdentity } from "../../providers/identity"
import type { Plugin } from "../types"
import { setClientIdentity } from "./api"
import { googleProvider } from "./provider"

const plugin: Plugin = {
  name: "google",
  register(ctx) {
    setClientIdentity(configuredClientIdentity("google", ctx.config))
    ctx.registerProvider(googleProvider)
  },
}

export default plugin
