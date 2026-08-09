export type PermissionMode = "build" | "plan" | "auto" | "yolo"

export type PermissionScope = "once" | "session" | "always"

export type PolicyDecision = "allow" | "deny" | "ask"

export interface PermissionRequest {
  tool: string
  title: string
  args: Record<string, unknown>
  subject: string | undefined
  readOnly: boolean
  sandboxed: boolean
  mode: PermissionMode
}

export interface PolicyRule {
  evaluate(request: PermissionRequest): PolicyDecision | undefined
}

export interface PermissionRules {
  allow?: string[]
  ask?: string[]
  deny?: string[]
}

export const permissionModes: PermissionMode[] = ["build", "plan", "auto", "yolo"]

export function isPermissionMode(value: string): value is PermissionMode {
  return permissionModes.some((mode) => mode === value)
}

export function nextPermissionMode(mode: PermissionMode): PermissionMode {
  const index = permissionModes.indexOf(mode)
  return permissionModes[(index + 1) % permissionModes.length]!
}
