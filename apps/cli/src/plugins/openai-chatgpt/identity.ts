import { defaultClientIdentity, type ClientIdentity } from "../../providers/identity"

let current = defaultClientIdentity()

export function setClientIdentity(identity: ClientIdentity): void {
  current = identity
}

export function clientIdentity(): ClientIdentity {
  return current
}
