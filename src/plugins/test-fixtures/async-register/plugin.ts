import type { PluginContext } from "../../types"

export default {
  name: "async-register-fixture",
  async register(ctx: PluginContext) {
    await Promise.resolve(ctx)
  },
}
