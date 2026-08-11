import { appInfo } from "../app-info"
import { asString } from "../lib/json"

export interface ClientIdentity {
  name: string
  userAgent: string
}

export function defaultClientIdentity(): ClientIdentity {
  return identityOf(appInfo.name)
}

export function configuredClientIdentity(pluginName: string, config: Record<string, unknown>): ClientIdentity {
  if (!("clientName" in config)) return defaultClientIdentity()
  const configured = asString(config.clientName)?.trim()
  if (!configured) throw new Error(`${pluginName} clientName must be a non-empty string`)
  return identityOf(configured)
}

function identityOf(name: string): ClientIdentity {
  return { name, userAgent: `${name}/${appInfo.version}` }
}
