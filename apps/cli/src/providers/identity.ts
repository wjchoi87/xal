import { appInfo } from "../app-info"
import { asString } from "../lib/json"

export interface ClientIdentity {
  name: string
  userAgent: string
}

export function clientIdentityOf(name: string): ClientIdentity {
  return { name, userAgent: `${name}/${appInfo.version}` }
}

export function defaultClientIdentity(): ClientIdentity {
  return clientIdentityOf(appInfo.name)
}

export function configuredClientIdentity(
  pluginName: string,
  config: Record<string, unknown>,
  defaultName: string = appInfo.name,
): ClientIdentity {
  if (!("clientName" in config)) return clientIdentityOf(defaultName)
  const configured = asString(config.clientName)?.trim()
  if (!configured) throw new Error(`${pluginName} clientName must be a non-empty string`)
  return clientIdentityOf(configured)
}
