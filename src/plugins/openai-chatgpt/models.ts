import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { appEnvVar } from "../../app-info"
import { cacheDir } from "../../config/paths"
import { asBoolean, asNumber, asString, asStringArray, isRecord } from "../../lib/json"
import { isThinkingEffort, type ModelInfo, type ThinkingEffort, type ThinkingOptions } from "../../providers/types"

const MODELS_URL = "https://models.dev/api.json"
const CACHE_TTL_MS = 24 * 60 * 60 * 1000

const BACKEND_MODEL_IDS = [
  "gpt-5.6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex-spark",
]

interface ModelMetadata {
  name?: string
  reasoning?: boolean
  contextWindow?: number
  maxOutput?: number
  thinking?: ThinkingEffort[]
}

type MetadataMap = Record<string, ModelMetadata>

let memo: MetadataMap | undefined

function parseThinking(raw: unknown): ThinkingEffort[] | undefined {
  if (!Array.isArray(raw)) return undefined
  for (const option of raw) {
    if (!isRecord(option) || option.type !== "effort") continue
    const efforts = asStringArray(option.values).filter(isThinkingEffort)
    if (efforts.length > 0) return efforts
  }
  return undefined
}

function cachePath(): string {
  return join(cacheDir(), "models.json")
}

function parseNetworkEntry(raw: unknown): ModelMetadata | undefined {
  if (!isRecord(raw)) return undefined
  const limit = isRecord(raw.limit) ? raw.limit : undefined
  return {
    name: asString(raw.name),
    reasoning: asBoolean(raw.reasoning),
    contextWindow: limit ? asNumber(limit.context) : undefined,
    maxOutput: limit ? asNumber(limit.output) : undefined,
    thinking: parseThinking(raw.reasoning_options),
  }
}

function parseCachedEntry(raw: unknown): ModelMetadata | undefined {
  if (!isRecord(raw)) return undefined
  const thinking = asStringArray(raw.thinking).filter(isThinkingEffort)
  return {
    name: asString(raw.name),
    reasoning: asBoolean(raw.reasoning),
    contextWindow: asNumber(raw.contextWindow),
    maxOutput: asNumber(raw.maxOutput),
    thinking: thinking.length > 0 ? thinking : undefined,
  }
}

function parseMetadataMap(raw: unknown, parseEntry: (raw: unknown) => ModelMetadata | undefined): MetadataMap {
  if (!isRecord(raw)) return {}
  const metadata: MetadataMap = {}
  for (const id of BACKEND_MODEL_IDS) {
    const entry = parseEntry(raw[id])
    if (entry) metadata[id] = entry
  }
  return metadata
}

async function readCache(): Promise<{ fetchedAt: number; metadata: MetadataMap } | undefined> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(cachePath(), "utf8"))
  } catch {
    return undefined
  }
  if (!isRecord(parsed)) return undefined
  const fetchedAt = asNumber(parsed.fetchedAt)
  if (fetchedAt === undefined) return undefined
  return { fetchedAt, metadata: parseMetadataMap(parsed.metadata, parseCachedEntry) }
}

async function writeCache(metadata: MetadataMap): Promise<void> {
  try {
    await mkdir(cacheDir(), { recursive: true })
    await writeFile(cachePath(), JSON.stringify({ fetchedAt: Date.now(), metadata }, null, 2) + "\n")
  } catch {}
}

async function fetchMetadata(): Promise<MetadataMap> {
  const response = await fetch(MODELS_URL, { signal: AbortSignal.timeout(15_000) })
  if (!response.ok) throw new Error(`models.dev returned ${response.status}`)
  const data: unknown = await response.json()
  if (!isRecord(data) || !isRecord(data.openai)) return {}
  return parseMetadataMap(data.openai.models, parseNetworkEntry)
}

async function loadMetadata(): Promise<MetadataMap> {
  if (memo) return memo
  const cache = await readCache()
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    memo = cache.metadata
    return memo
  }
  try {
    const fresh = await fetchMetadata()
    await writeCache(fresh)
    memo = fresh
    return memo
  } catch {
    memo = cache?.metadata ?? {}
    return memo
  }
}

export async function listModels(): Promise<ModelInfo[]> {
  const metadata = await loadMetadata()
  return BACKEND_MODEL_IDS.map((id) => ({
    id,
    name: metadata[id]?.name ?? id,
    contextWindow: metadata[id]?.contextWindow,
    maxOutput: metadata[id]?.maxOutput,
    reasoning: metadata[id]?.reasoning,
  }))
}

export async function defaultModel(): Promise<string> {
  const override = process.env[appEnvVar("MODEL")]?.trim()
  if (override) return override
  return BACKEND_MODEL_IDS[0]!
}

export async function thinking(model: string): Promise<ThinkingOptions | undefined> {
  const metadata = await loadMetadata()
  const options = metadata[model]?.thinking
  if (options) return { options, default: "medium" }
  if (!BACKEND_MODEL_IDS.includes(model)) return undefined
  return {
    options: model.startsWith("gpt-5.6-")
      ? ["none", "low", "medium", "high", "xhigh", "max"]
      : ["none", "low", "medium", "high", "xhigh"],
    default: "medium",
  }
}
