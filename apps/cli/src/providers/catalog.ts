import { listProfiles, type ProviderProfile } from "../config/credentials"
import { describeError } from "../lib/error"
import { getProvider, listProviders } from "./registry"
import type { ModelCatalog, ModelCatalogSource, ModelInfo, Provider } from "./types"

export interface ModelChoice {
  provider: Provider
  profile: ProviderProfile
  model: ModelInfo
  source: ModelCatalogSource
}

export interface CatalogNotice {
  provider: Provider
  profile: ProviderProfile
  message: string
}

export interface ModelChoices {
  choices: ModelChoice[]
  notices: CatalogNotice[]
}

export interface ConnectTarget {
  provider: Provider
  profiles: number
}

export function providerLabel(provider: Provider): string {
  return provider.aliases[0] ?? provider.id
}

export function profileProviderLabel(profile: ProviderProfile): string {
  return getProvider(profile.provider)?.name ?? `${profile.provider} · unavailable`
}

export async function listConnectTargets(): Promise<ConnectTarget[]> {
  const profiles = await listProfiles()
  return listProviders().flatMap((provider) => {
    if (!provider.connect) return []
    return [{ provider, profiles: profiles.filter((profile) => profile.provider === provider.id).length }]
  })
}

const catalogs = new Map<string, Promise<ModelCatalog>>()

function catalogKey(provider: Provider, profileId: string): string {
  return `${provider.id}:${profileId}`
}

function validateCatalog(provider: Provider, catalog: ModelCatalog): ModelCatalog {
  const ids = new Set<string>()
  for (const model of catalog.models) {
    if (!model.id.trim()) throw new Error(`${provider.name} returned a model with no ID`)
    if (!model.name.trim()) throw new Error(`${provider.name} returned model ${model.id} with no name`)
    if (ids.has(model.id)) throw new Error(`${provider.name} returned duplicate model ${model.id}`)
    if (model.contextWindow !== undefined && (!Number.isInteger(model.contextWindow) || model.contextWindow <= 0)) {
      throw new Error(`${provider.name} returned an invalid context window for ${model.id}`)
    }
    if (model.thinking && !model.thinking.options.includes(model.thinking.default)) {
      throw new Error(`${provider.name} returned an invalid default thinking effort for ${model.id}`)
    }
    ids.add(model.id)
  }
  return catalog
}

export function clearModelCatalog(profileId: string): void {
  for (const key of catalogs.keys()) {
    if (key.endsWith(`:${profileId}`)) catalogs.delete(key)
  }
}

export function modelCatalog(provider: Provider, profileId: string, refresh = false): Promise<ModelCatalog> {
  const key = catalogKey(provider, profileId)
  if (refresh) catalogs.delete(key)
  const cached = catalogs.get(key)
  if (cached) return cached

  const lookup = Promise.resolve()
    .then(() => provider.listModels(profileId, refresh))
    .then((catalog) => validateCatalog(provider, catalog))
    .catch((error) => {
      if (catalogs.get(key) === lookup) catalogs.delete(key)
      throw error
    })
  catalogs.set(key, lookup)
  return lookup
}

export async function contextWindow(provider: Provider, profileId: string, model: string): Promise<number | undefined> {
  return (await findModel(provider, profileId, model))?.contextWindow
}

export async function findModel(
  provider: Provider,
  profileId: string,
  model: string,
  refresh = false,
): Promise<ModelInfo | undefined> {
  const catalog = await modelCatalog(provider, profileId, refresh)
  return catalog.models.find((info) => info.id === model)
}

export function modelSummary(model: ModelInfo, listReasoning = false): string {
  const details: string[] = []
  if (model.contextWindow) details.push(`${Math.round(model.contextWindow / 1_000)}k${listReasoning ? " ctx" : ""}`)
  if (model.inputModalities.includes("image")) details.push(listReasoning ? "image" : "img")
  if (model.thinking) details.push(listReasoning ? `reasoning ${model.thinking.options.join("/")}` : "think")
  return details.join(" · ")
}

export async function listModelChoices(refresh = false): Promise<ModelChoices> {
  const grouped = await Promise.all(
    (await listProfiles()).map(async (profile): Promise<ModelChoices> => {
      const provider = getProvider(profile.provider)
      if (!provider) return { choices: [], notices: [] }
      try {
        const catalog = await modelCatalog(provider, profile.id, refresh)
        return {
          choices: catalog.models.map((model) => ({ provider, profile, model, source: catalog.source })),
          notices: catalog.warning ? [{ provider, profile, message: catalog.warning }] : [],
        }
      } catch (error) {
        return { choices: [], notices: [{ provider, profile, message: describeError(error) }] }
      }
    }),
  )
  return {
    choices: grouped.flatMap((group) => group.choices),
    notices: grouped.flatMap((group) => group.notices),
  }
}
