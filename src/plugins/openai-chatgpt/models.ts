import { join } from "node:path"
import { appEnvVar } from "../../app-info"
import { cacheDir } from "../../config/paths"
import { readJsonFile, writeSecureJson } from "../../lib/fs"
import { describeError } from "../../lib/error"
import { asNumber, asString, asStringArray, isRecord } from "../../lib/json"
import { errorDetail, httpError } from "../../providers/transport"
import {
  isThinkingEffort,
  type ModelCatalog,
  type ModelInfo,
  type ModelInputModality,
  type ThinkingEffort,
  type ThinkingOptions,
} from "../../providers/types"
import { chatGptFetch } from "./api"

const MODEL_CATALOG_COMPATIBILITY_VERSION = "1.0.0"
const DEFAULT_CONTEXT_WINDOW = 260_000

const BUNDLED_MODELS: ModelInfo[] = [
  {
    id: "gpt-5.6-luna",
    name: "GPT-5.6-Luna",
    contextWindow: 272_000,
    inputModalities: ["text", "image"],
    thinking: { options: ["low", "medium", "high", "xhigh", "max"], default: "medium" },
  },
  {
    id: "gpt-5.6-sol",
    name: "GPT-5.6-Sol",
    contextWindow: 272_000,
    inputModalities: ["text", "image"],
    thinking: { options: ["low", "medium", "high", "xhigh", "max"], default: "low" },
  },
  {
    id: "gpt-5.6-terra",
    name: "GPT-5.6-Terra",
    contextWindow: 272_000,
    inputModalities: ["text", "image"],
    thinking: { options: ["low", "medium", "high", "xhigh", "max"], default: "medium" },
  },
  {
    id: "gpt-5.5",
    name: "GPT-5.5",
    contextWindow: 272_000,
    inputModalities: ["text", "image"],
    thinking: { options: ["low", "medium", "high", "xhigh"], default: "medium" },
  },
  {
    id: "gpt-5.4",
    name: "GPT-5.4",
    contextWindow: 272_000,
    inputModalities: ["text", "image"],
    thinking: { options: ["low", "medium", "high", "xhigh"], default: "medium" },
  },
  {
    id: "gpt-5.4-mini",
    name: "GPT-5.4-Mini",
    contextWindow: 272_000,
    inputModalities: ["text", "image"],
    thinking: { options: ["low", "medium", "high", "xhigh"], default: "medium" },
  },
  {
    id: "gpt-5.3-codex-spark",
    name: "GPT-5.3-Codex-Spark",
    contextWindow: 128_000,
    inputModalities: ["text"],
    thinking: { options: ["low", "medium", "high", "xhigh"], default: "high" },
  },
]

let contextWindowCap = DEFAULT_CONTEXT_WINDOW

export function setContextWindowCap(cap: number | undefined): void {
  contextWindowCap = cap ?? DEFAULT_CONTEXT_WINDOW
}

function cachePath(): string {
  return join(cacheDir(), "openai-chatgpt-models.json")
}

function inputModalities(raw: unknown): ModelInputModality[] {
  const modalities = asStringArray(raw).filter(
    (modality): modality is ModelInputModality => modality === "text" || modality === "image",
  )
  return modalities.length > 0 ? modalities : ["text"]
}

function thinkingOptions(options: ThinkingEffort[], preferred: unknown): ThinkingOptions | undefined {
  if (options.length === 0) return undefined
  const defaultEffort = isThinkingEffort(preferred) && options.includes(preferred) ? preferred : options[0]!
  return { options, default: defaultEffort }
}

function runtimeThinking(raw: unknown, preferred: unknown): ThinkingOptions | undefined {
  if (!Array.isArray(raw)) return undefined
  const options = raw.flatMap((entry): ThinkingEffort[] => {
    if (!isRecord(entry)) return []
    const effort = asString(entry.effort)
    return effort && isThinkingEffort(effort) ? [effort] : []
  })
  return thinkingOptions(options, preferred)
}

function positiveInteger(raw: unknown): number | undefined {
  const value = asNumber(raw)
  return value !== undefined && Number.isInteger(value) && value > 0 ? value : undefined
}

function parseRuntimeModel(raw: unknown): { model: ModelInfo; priority: number } | undefined {
  if (!isRecord(raw)) throw new Error("ChatGPT models response contained an invalid model")
  if (raw.visibility !== "list") return undefined
  const id = asString(raw.slug)?.trim()
  const name = asString(raw.display_name)?.trim()
  if (!id || !name) throw new Error("ChatGPT models response contained an incomplete visible model")
  return {
    model: {
      id,
      name,
      contextWindow: positiveInteger(raw.context_window) ?? positiveInteger(raw.max_context_window),
      inputModalities: inputModalities(raw.input_modalities),
      thinking: runtimeThinking(raw.supported_reasoning_levels, raw.default_reasoning_level),
    },
    priority: asNumber(raw.priority) ?? Number.MAX_SAFE_INTEGER,
  }
}

async function discoverModels(): Promise<ModelInfo[]> {
  const response = await chatGptFetch(`/models?client_version=${MODEL_CATALOG_COMPATIBILITY_VERSION}`, {
    signal: AbortSignal.timeout(5_000),
  })
  if (!response.ok) {
    const text = await response.text().catch(() => "")
    throw httpError("ChatGPT models", response, errorDetail(text) ?? text.slice(0, 500))
  }
  const raw: unknown = await response.json()
  if (!isRecord(raw) || !Array.isArray(raw.models)) throw new Error("ChatGPT models response was invalid")
  const models = raw.models
    .flatMap((entry) => {
      const parsed = parseRuntimeModel(entry)
      return parsed ? [parsed] : []
    })
    .sort((left, right) => left.priority - right.priority)
    .map((entry) => entry.model)
  if (models.length === 0) throw new Error("ChatGPT returned no visible models")
  return models
}

function parseCachedThinking(raw: unknown): ThinkingOptions | undefined {
  if (!isRecord(raw)) return undefined
  const options = asStringArray(raw.options).filter(isThinkingEffort)
  return thinkingOptions(options, raw.default)
}

function parseCachedModel(raw: unknown): ModelInfo | undefined {
  if (!isRecord(raw)) return undefined
  const id = asString(raw.id)?.trim()
  const name = asString(raw.name)?.trim()
  if (!id || !name) return undefined
  return {
    id,
    name,
    contextWindow: positiveInteger(raw.contextWindow),
    inputModalities: inputModalities(raw.inputModalities),
    thinking: parseCachedThinking(raw.thinking),
  }
}

async function readCache(): Promise<ModelInfo[] | undefined> {
  const raw = await readJsonFile(cachePath())
  if (raw === undefined) return undefined
  if (!isRecord(raw) || !Array.isArray(raw.models)) throw new Error(`${cachePath()} is malformed — fix or delete it`)
  const models: ModelInfo[] = []
  for (const entry of raw.models) {
    const model = parseCachedModel(entry)
    if (!model) throw new Error(`${cachePath()} is malformed — fix or delete it`)
    models.push(model)
  }
  return models.length > 0 ? models : undefined
}

function capped(models: ModelInfo[]): ModelInfo[] {
  return models.map((model) => ({
    ...model,
    contextWindow:
      model.contextWindow === undefined ? contextWindowCap : Math.min(model.contextWindow, contextWindowCap),
  }))
}

async function refreshModels(): Promise<ModelCatalog> {
  try {
    const models = await discoverModels()
    try {
      await writeSecureJson(cachePath(), { models })
      return { models: capped(models), source: "runtime" }
    } catch (error) {
      return {
        models: capped(models),
        source: "runtime",
        warning: `models were discovered, but the cache could not be updated: ${describeError(error)}`,
      }
    }
  } catch (discoveryError) {
    try {
      const cached = await readCache()
      if (cached) {
        return {
          models: capped(cached),
          source: "cache",
          warning: `live discovery failed: ${describeError(discoveryError)} — using cached models`,
        }
      }
    } catch (cacheError) {
      return {
        models: capped(BUNDLED_MODELS),
        source: "bundled",
        warning: `live discovery failed: ${describeError(discoveryError)}; cache failed: ${describeError(cacheError)} — using bundled models`,
      }
    }
    return {
      models: capped(BUNDLED_MODELS),
      source: "bundled",
      warning: `live discovery failed: ${describeError(discoveryError)} — using bundled models`,
    }
  }
}

export async function listModels(refresh: boolean): Promise<ModelCatalog> {
  if (refresh) return refreshModels()
  try {
    const cached = await readCache()
    if (cached) return { models: capped(cached), source: "cache" }
  } catch (cacheError) {
    const refreshed = await refreshModels()
    if (refreshed.warning) return refreshed
    return {
      ...refreshed,
      warning: `cached catalog failed: ${describeError(cacheError)} — replaced with live models`,
    }
  }
  return refreshModels()
}

export async function defaultModel(): Promise<string> {
  const override = process.env[appEnvVar("MODEL")]?.trim()
  return override || BUNDLED_MODELS[0]!.id
}
