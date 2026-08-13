import { registerPrompt } from "../../agent/prompt"
import { contributeRules, isDenied, matchRules } from "../../permissions/rules"
import { registerPolicyRule } from "../../permissions/service"
import type { PermissionRequest, PolicyDecision } from "../../permissions/types"
import { registerTool } from "../registry"
import { shellPrompt } from "./shell"
import { splitCommand } from "./split"
import { bashTool, commandOf, sandboxRequested } from "./tool"

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

function segmentDecision(request: PermissionRequest, segment: string): PolicyDecision | undefined {
  const scoped = { ...request, subject: segment }
  if (isDenied(scoped)) return "deny"
  return matchRules(scoped)
}

export function registerBash(): void {
  registerTool(bashTool)
  registerPrompt({ id: "environment", text: shellPrompt })
  contributeRules({ ask: DANGEROUS })
  registerPolicyRule({
    evaluate(request) {
      if (request.tool !== "bash" || sandboxRequested(request.args)) return undefined
      const command = commandOf(request.args)
      if (!command) return undefined
      const split = splitCommand(command)
      if (!split) return "ask"
      if (split.segments.length < 2) return undefined
      const decisions = split.segments.map((segment) => segmentDecision(request, segment))
      if (decisions.includes("deny")) return "deny"
      if (decisions.includes("ask")) return "ask"
      return decisions.every((decision) => decision === "allow") ? "allow" : undefined
    },
  })
}
