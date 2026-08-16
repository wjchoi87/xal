import { join } from "node:path"
import { cacheDir } from "../../config/paths"
import { describeError } from "../../lib/error"
import { readJsonFile, writeSecureJson } from "../../lib/fs"
import { asString, isRecord } from "../../lib/json"
import type { ModelCatalog, ModelInfo } from "../../providers/types"
import { anthropicFetch } from "./api"

const BUNDLED_MODELS: ModelInfo[] = [
  {
    id: "claude-opus-4-8",
    name: "Claude Opus 4.8",
    contextWindow: 1_000_000,
    inputModalities: ["text", "image"],
    thinking: { options: ["none", "low", "medium", "high", "xhigh", "max"], default: "high" },
  },
  {
    id: "claude-opus-5",
    name: "Claude Opus 5",
    contextWindow: 1_000_000,
    inputModalities: ["text", "image"],
    thinking: { options: ["none", "low", "medium", "high", "xhigh", "max"], default: "high" },
  },
  {
    id: "claude-sonnet-5",
    name: "Claude Sonnet 5",
    contextWindow: 1_000_000,
    inputModalities: ["text", "image"],
    thinking: { options: ["none", "low", "medium", "high", "xhigh", "max"], default: "high" },
  },
  {
    id: "claude-fable-5",
    name: "Claude Fable 5",
    contextWindow: 1_000_000,
    inputModalities: ["text", "image"],
    thinking: { options: ["low", "medium", "high", "xhigh", "max"], default: "high" },
  },
  {
    id: "claude-opus-4-7",
    name: "Claude Opus 4.7",
    contextWindow: 1_000_000,
    inputModalities: ["text", "image"],
    thinking: { options: ["none", "low", "medium", "high", "xhigh", "max"], default: "high" },
  },
  {
    id: "claude-opus-4-6",
    name: "Claude Opus 4.6",
    contextWindow: 1_000_000,
    inputModalities: ["text", "image"],
    thinking: { options: ["none", "low", "medium", "high", "max"], default: "high" },
  },
  {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    contextWindow: 1_000_000,
    inputModalities: ["text", "image"],
    thinking: { options: ["none", "low", "medium", "high", "max"], default: "high" },
  },
  {
    id: "claude-sonnet-4-5",
    name: "Claude Sonnet 4.5",
    contextWindow: 1_000_000,
    inputModalities: ["text", "image"],
    thinking: { options: ["none", "low", "medium", "high"], default: "medium" },
  },
  {
    id: "claude-opus-4-5",
    name: "Claude Opus 4.5",
    contextWindow: 200_000,
    inputModalities: ["text", "image"],
    thinking: { options: ["none", "low", "medium", "high"], default: "high" },
  },
  {
    id: "claude-haiku-4-5",
    name: "Claude Haiku 4.5",
    contextWindow: 200_000,
    inputModalities: ["text", "image"],
    thinking: { options: ["none", "low", "medium", "high"], default: "medium" },
  },
]

function modelInfo(id: string, name: string): ModelInfo {
  const bundled = BUNDLED_MODELS.find((model) => id === model.id || id.startsWith(`${model.id}-20`))
  return bundled ? { ...bundled, id, name } : { id, name, inputModalities: ["text", "image"] }
}

function cachePath(): string {
  return join(cacheDir(), "anthropic-models.json")
}

async function readCache(): Promise<ModelInfo[] | undefined> {
  const raw = await readJsonFile(cachePath())
  if (raw === undefined) return undefined
  if (!isRecord(raw) || !Array.isArray(raw.models)) {
    throw new Error(`${cachePath()} is malformed; fix or delete it`)
  }
  const models: ModelInfo[] = []
  for (const entry of raw.models) {
    if (!isRecord(entry)) throw new Error(`${cachePath()} is malformed; fix or delete it`)
    const id = asString(entry.id)?.trim()
    const name = asString(entry.name)?.trim()
    if (!id || !name) throw new Error(`${cachePath()} is malformed; fix or delete it`)
    models.push(modelInfo(id, name))
  }
  return models.length > 0 ? models : undefined
}

async function discoverModels(): Promise<ModelInfo[]> {
  const response = await anthropicFetch("/v1/models?limit=100", { signal: AbortSignal.timeout(15_000) })
  const raw: unknown = await response.json()
  if (!isRecord(raw) || !Array.isArray(raw.data)) throw new Error("Anthropic models response was invalid")
  const models: ModelInfo[] = []
  for (const entry of raw.data) {
    if (!isRecord(entry)) throw new Error("Anthropic models response contained an invalid model")
    const id = asString(entry.id)?.trim()
    const name = asString(entry.display_name)?.trim() ?? id
    if (!id || !name) throw new Error("Anthropic models response contained a model with no ID")
    models.push(modelInfo(id, name))
  }
  if (models.length === 0) throw new Error("Anthropic returned no models")
  return models
}

export async function listModels(refresh: boolean): Promise<ModelCatalog> {
  if (!refresh) {
    try {
      const cached = await readCache()
      return cached ? { models: cached, source: "cache" } : { models: BUNDLED_MODELS, source: "bundled" }
    } catch (error) {
      return {
        models: BUNDLED_MODELS,
        source: "bundled",
        warning: `cached catalog failed: ${describeError(error)}; using bundled models`,
      }
    }
  }

  try {
    const models = await discoverModels()
    try {
      await writeSecureJson(cachePath(), { models: models.map(({ id, name }) => ({ id, name })) })
      return { models, source: "runtime" }
    } catch (error) {
      return {
        models,
        source: "runtime",
        warning: `models were discovered, but the cache could not be updated: ${describeError(error)}`,
      }
    }
  } catch (discoveryError) {
    try {
      const cached = await readCache()
      if (cached) {
        return {
          models: cached,
          source: "cache",
          warning: `live discovery failed: ${describeError(discoveryError)}; using cached models`,
        }
      }
    } catch (cacheError) {
      return {
        models: BUNDLED_MODELS,
        source: "bundled",
        warning: `live discovery failed: ${describeError(discoveryError)}; cache failed: ${describeError(cacheError)}; using bundled models`,
      }
    }
    return {
      models: BUNDLED_MODELS,
      source: "bundled",
      warning: `live discovery failed: ${describeError(discoveryError)}; using bundled models`,
    }
  }
}

export async function defaultModel(): Promise<string> {
  return BUNDLED_MODELS[0]!.id
}
