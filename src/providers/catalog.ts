import { listProviders } from "./registry"
import type { ModelCatalog, ModelCatalogSource, ModelInfo, Provider } from "./types"

export interface ModelChoice {
  provider: Provider
  model: ModelInfo
  source: ModelCatalogSource
}

export interface CatalogNotice {
  provider: Provider
  message: string
}

export interface ModelChoices {
  choices: ModelChoice[]
  notices: CatalogNotice[]
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

const catalogs = new Map<string, Promise<ModelCatalog>>()

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

export function modelCatalog(provider: Provider, refresh = false): Promise<ModelCatalog> {
  if (refresh) catalogs.delete(provider.id)
  const cached = catalogs.get(provider.id)
  if (cached) return cached

  const lookup = Promise.resolve()
    .then(() => provider.listModels(refresh))
    .then((catalog) => validateCatalog(provider, catalog))
    .catch((error) => {
      if (catalogs.get(provider.id) === lookup) catalogs.delete(provider.id)
      throw error
    })
  catalogs.set(provider.id, lookup)
  return lookup
}

export async function contextWindow(provider: Provider, model: string): Promise<number | undefined> {
  return (await findModel(provider, model))?.contextWindow
}

export async function findModel(provider: Provider, model: string, refresh = false): Promise<ModelInfo | undefined> {
  const catalog = await modelCatalog(provider, refresh)
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
    listProviders().map(async (provider): Promise<ModelChoices> => {
      const connected = await provider.isLoggedIn().catch(() => false)
      if (!connected) return { choices: [], notices: [] }
      const catalog = await modelCatalog(provider, refresh)
      return {
        choices: catalog.models.map((model) => ({ provider, model, source: catalog.source })),
        notices: catalog.warning ? [{ provider, message: catalog.warning }] : [],
      }
    }),
  )
  return {
    choices: grouped.flatMap((group) => group.choices),
    notices: grouped.flatMap((group) => group.notices),
  }
}
