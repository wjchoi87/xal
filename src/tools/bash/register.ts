import { registerPrompt } from "../../agent/prompt"
import { contributeRules, isDenied, matchRules } from "../../permissions/rules"
import { registerPolicyRule } from "../../permissions/service"
import type { PermissionRequest, PolicyDecision } from "../../permissions/types"
import { registerTool } from "../registry"
import { commandEscapesWorkspace } from "./risk"
import { shellPrompt } from "./shell"
import { splitCommand } from "./split"
import { bashTool, commandOf, sandboxRequested } from "./tool"

const RISKY = [
  "bash(sudo *)",
  "bash(doas *)",
  "bash(dd *)",
  "bash(mkfs*)",
  "bash(shutdown*)",
  "bash(reboot*)",
  "bash(curl *)",
  "bash(wget *)",
  "bash(git push --force*)",
  "bash(git push -f*)",
  "bash(npm publish*)",
  "bash(pnpm publish*)",
  "bash(yarn publish*)",
  "bash(bun publish*)",
  "bash(cargo publish*)",
]

function segmentDecision(request: PermissionRequest, segment: string): PolicyDecision | undefined {
  const scoped = { ...request, subject: segment }
  if (isDenied(scoped)) return "deny"
  const matched = matchRules(scoped)
  if (matched) return matched
  return commandEscapesWorkspace(segment, request.cwd) ? "ask" : undefined
}

export function registerBash(): void {
  registerTool(bashTool)
  registerPrompt({ id: "environment", text: shellPrompt })
  contributeRules({ ask: RISKY })
  registerPolicyRule({
    evaluate(request) {
      if (request.tool !== "bash" || sandboxRequested(request.args)) return undefined
      const command = commandOf(request.args)
      if (!command) return undefined
      const segments = splitCommand(command)
      if (!segments) return "ask"
      const decisions = segments.map((segment) => segmentDecision(request, segment))
      if (decisions.includes("deny")) return "deny"
      if (decisions.includes("ask")) return "ask"
      return decisions.every((decision) => decision === "allow") ? "allow" : undefined
    },
  })
}
