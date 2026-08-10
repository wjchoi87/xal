import type { Plugin } from "../types"
import { initializeShellSnapshot, shellSnapshotPrompt } from "./environment"
import { bashKillTool, bashOutputTool } from "./job-tools"
import { bashTool, COMPOUND_COMMAND, policyCommandOf, sandboxRequested } from "./tool"

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
    ctx.registerPrompt({ id: "environment", text: shellSnapshotPrompt })
    ctx.registerPermissionRules({ ask: DANGEROUS })
    ctx.registerPolicyRule({
      evaluate: (request) =>
        request.tool === "bash" &&
        !sandboxRequested(request.args) &&
        COMPOUND_COMMAND.test(policyCommandOf(request.args))
          ? "ask"
          : undefined,
    })
    ctx.registerPolicyRule({
      evaluate: (request) => (request.tool === "bash_kill" ? "allow" : undefined),
    })
  },
  async bootstrap() {
    await initializeShellSnapshot()
  },
}

export default plugin
