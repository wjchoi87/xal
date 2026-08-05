import type { Provider } from "./types"

const providers = new Map<string, Provider>()

export function registerProvider(provider: Provider): void {
  providers.set(provider.id, provider)
  for (const alias of provider.aliases) {
    providers.set(alias, provider)
  }
}

export function getProvider(idOrAlias: string): Provider | undefined {
  return providers.get(idOrAlias)
}

export function listProviders(): Provider[] {
  return [...new Set(providers.values())]
}
