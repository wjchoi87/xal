export interface PermissionRequest {
  tool: string
  title: string
}

export type PolicyDecision = "allow" | "deny" | "ask"

export interface PermissionPolicy {
  evaluate(request: PermissionRequest): PolicyDecision
}

export const askPolicy: PermissionPolicy = {
  evaluate: () => "ask",
}
