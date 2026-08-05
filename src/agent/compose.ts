import { settings } from "../config/settings"
import { getProvider, listProviders } from "../providers/registry"
import type { Provider } from "../providers/types"
import { AgentSession } from "./agent-session"

export interface SessionSetup {
  session: AgentSession
  provider: Provider
  model: string
}

export function resolveProvider(id?: string): Provider {
  const wanted = id ?? settings().provider
  if (wanted) {
    const provider = getProvider(wanted)
    if (!provider) throw new Error(`unknown provider: ${wanted}`)
    return provider
  }
  const provider = listProviders().at(-1)
  if (!provider) throw new Error("no provider registered")
  return provider
}

export async function createSession(providerId?: string, modelId?: string): Promise<SessionSetup> {
  const provider = resolveProvider(providerId)
  const model = modelId ?? settings().model ?? (await provider.defaultModel())
  return { session: new AgentSession({ provider, model }), provider, model }
}
