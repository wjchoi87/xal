import type { Plugin } from "../types"
import { deepSeekProvider } from "./provider"

const plugin: Plugin = {
  name: "deepseek",
  register(ctx) {
    ctx.registerProvider(deepSeekProvider)
  },
}

export default plugin
