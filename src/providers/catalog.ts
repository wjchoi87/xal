import { listProviders } from "./registry"
import type { ModelInfo, Provider } from "./types"

export interface ModelChoice {
  provider: Provider
  model: ModelInfo
}

export interface ConnectTarget {
  provider: Provider
  connected: boolean
}

export async function listConnectTargets(): Promise<ConnectTarget[]> {
  const targets = await Promise.all(
    listProviders().map(async (provider): Promise<ConnectTarget[]> => {
      if (!provider.connect) return []
      return [{ provider, connected: await provider.isLoggedIn().catch(() => false) }]
    }),
  )
  return targets.flat()
}

export async function listModelChoices(): Promise<ModelChoice[]> {
  const grouped = await Promise.all(
    listProviders().map(async (provider): Promise<ModelChoice[]> => {
      const connected = await provider.isLoggedIn().catch(() => false)
      if (!connected) return []
      const models = await provider.listModels().catch((): ModelInfo[] => [])
      return models.map((model) => ({ provider, model }))
    }),
  )
  return grouped.flat()
}
