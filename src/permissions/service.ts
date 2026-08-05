export interface PermissionRequest {
  tool: string
  title: string
  args: Record<string, unknown>
  readOnly: boolean
}

export type PolicyDecision = "allow" | "deny" | "ask"

export interface PolicyRule {
  id: string
  evaluate(request: PermissionRequest): PolicyDecision | undefined
}

const rules: PolicyRule[] = []

export function registerPolicyRule(rule: PolicyRule): void {
  rules.push(rule)
}

export function evaluatePolicy(request: PermissionRequest): PolicyDecision {
  for (let index = rules.length - 1; index >= 0; index--) {
    const decision = rules[index]!.evaluate(request)
    if (decision) return decision
  }
  return "ask"
}
