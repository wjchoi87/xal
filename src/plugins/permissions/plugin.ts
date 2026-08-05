import type { Plugin } from "../types"

const plugin: Plugin = {
  name: "permissions",
  register(ctx) {
    ctx.registerPolicyRule({
      id: "allow-read-only",
      evaluate: (request) => (request.readOnly ? "allow" : undefined),
    })
  },
}

export default plugin
