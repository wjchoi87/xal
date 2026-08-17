import { clientIdentityOf, type ClientIdentity } from "../../providers/identity"

export const defaultClientName = "codex_cli_rs"

let current = clientIdentityOf(defaultClientName)

export function setClientIdentity(identity: ClientIdentity): void {
  current = identity
}

export function clientIdentity(): ClientIdentity {
  return current
}
