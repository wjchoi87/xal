import type { Plugin } from "../types"
import { bashTool } from "./tool"

const plugin: Plugin = {
  name: "bash",
  register(ctx) {
    ctx.registerTool(bashTool)
    ctx.registerToolRenderer({
      tool: "bash",
      waitingLabel(title) {
        if (/\b(?:bun|cargo|npm|pnpm|yarn)?\s*(?:run\s+)?(?:test|pytest|jest|vitest)\b/i.test(title)) {
          return "Waiting for tests"
        }
        if (/\b(?:build|compile|tsc)\b/i.test(title)) return "Waiting for build"
        if (/\b(?:install|add)\b/i.test(title)) return "Waiting for install"
        return "Waiting for command"
      },
    })
  },
}

export default plugin
