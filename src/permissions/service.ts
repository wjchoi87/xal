import { isDenied, loadRememberedRules, matchRules } from "./rules"
import type { PermissionMode, PermissionRequest, PolicyDecision, PolicyRule } from "./types"

const rules: PolicyRule[] = []

export function registerPolicyRule(rule: PolicyRule): void {
  rules.push(rule)
}

function evaluateRegistered(request: PermissionRequest): PolicyDecision | undefined {
  for (let index = rules.length - 1; index >= 0; index--) {
    const decision = rules[index]!.evaluate(request)
    if (decision) return decision
  }
  return undefined
}

function underMode(decision: PolicyDecision, mode: PermissionMode): PolicyDecision {
  return mode === "yolo" && decision === "ask" ? "allow" : decision
}

export async function evaluatePolicy(request: PermissionRequest): Promise<PolicyDecision> {
  await loadRememberedRules()

  if (isDenied(request)) return "deny"
  if (request.mode === "plan" && !request.readOnly) return "deny"

  const registered = evaluateRegistered(request)
  if (registered) return underMode(registered, request.mode)

  const matched = matchRules(request)
  if (matched) return underMode(matched, request.mode)

  if (request.readOnly || request.sandboxed) return "allow"
  if (request.mode === "build") return "ask"
  if (request.mode === "plan") return "deny"
  return "allow"
}
