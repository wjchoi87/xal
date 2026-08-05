import type { PermissionDecision, PermissionRequest, PermissionService } from "../permissions/service"

export class TuiPermissionService implements PermissionService {
  private pending: ((decision: PermissionDecision) => void) | undefined

  constructor(
    private readonly hooks: {
      onRequest(request: PermissionRequest): void
      onResolve(decision: PermissionDecision): void
    },
  ) {}

  requestPermission(request: PermissionRequest): Promise<PermissionDecision> {
    this.hooks.onRequest(request)
    return new Promise((resolve) => {
      this.pending = resolve
    })
  }

  get hasPending(): boolean {
    return this.pending !== undefined
  }

  resolvePending(decision: PermissionDecision): void {
    const resolve = this.pending
    if (!resolve) return
    this.pending = undefined
    this.hooks.onResolve(decision)
    resolve(decision)
  }
}
