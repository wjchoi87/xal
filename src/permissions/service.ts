export interface PermissionRequest {
  tool: string
  title: string
  detail?: string
}

export type PermissionDecision = "allow" | "deny"

export interface PermissionService {
  requestPermission(request: PermissionRequest): Promise<PermissionDecision>
}
