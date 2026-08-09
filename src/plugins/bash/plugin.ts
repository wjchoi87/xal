import type { Plugin } from "../types"
import { bashKillTool, bashOutputTool } from "./job-tools"
import { bashTool, commandOf, COMPOUND_COMMAND, sandboxRequested } from "./tool"

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
    ctx.registerTool(bashOutputTool)
    ctx.registerTool(bashKillTool)
    ctx.registerPermissionRules({ ask: DANGEROUS })
    ctx.registerPolicyRule({
      evaluate: (request) =>
        request.tool === "bash" && !sandboxRequested(request.args) && COMPOUND_COMMAND.test(commandOf(request.args))
          ? "ask"
          : undefined,
    })
    ctx.registerPolicyRule({
      evaluate: (request) => (request.tool === "bash_kill" ? "allow" : undefined),
    })
  },
}

export default plugin
