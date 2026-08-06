import type { Plugin } from "../types"
import { bashTool, commandOf, COMPOUND_COMMAND } from "./tool"

const DANGEROUS = [
  "bash(rm *)",
  "bash(sudo *)",
  "bash(doas *)",
  "bash(chmod *)",
  "bash(chown *)",
  "bash(dd *)",
  "bash(mkfs*)",
  "bash(kill *)",
  "bash(pkill *)",
  "bash(killall *)",
  "bash(shutdown*)",
  "bash(reboot*)",
  "bash(curl *)",
  "bash(wget *)",
  "bash(git push --force*)",
  "bash(git push -f*)",
  "bash(git reset --hard*)",
  "bash(git clean *)",
  "bash(npm publish*)",
  "bash(pnpm publish*)",
  "bash(yarn publish*)",
  "bash(bun publish*)",
  "bash(cargo publish*)",
]

const plugin: Plugin = {
  name: "bash",
  register(ctx) {
    ctx.registerTool(bashTool)
    ctx.registerPermissionRules({ ask: DANGEROUS })
    ctx.registerPolicyRule({
      id: "bash-compound-command",
      evaluate: (request) =>
        request.tool === "bash" && COMPOUND_COMMAND.test(commandOf(request.args)) ? "ask" : undefined,
    })
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
