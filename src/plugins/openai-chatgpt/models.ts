import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { appInfo } from "../../app-info"
import { cacheDir } from "../../config/paths"
import { asBoolean, asNumber, asString, isRecord } from "../../lib/json"
import type { ModelInfo } from "../../providers/types"

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
}

type MetadataMap = Record<string, ModelMetadata>

let memo: MetadataMap | undefined

function cachePath(): string {
  return join(cacheDir(), "models.json")
}

function parseMetadataEntry(raw: unknown): ModelMetadata | undefined {
  if (!isRecord(raw)) return undefined
  const limit = isRecord(raw.limit) ? raw.limit : undefined
  return {
    name: asString(raw.name),
    reasoning: asBoolean(raw.reasoning),
    contextWindow: asNumber(raw.contextWindow) ?? (limit ? asNumber(limit.context) : undefined),
    maxOutput: asNumber(raw.maxOutput) ?? (limit ? asNumber(limit.output) : undefined),
  }
}

function parseMetadataMap(raw: unknown): MetadataMap {
  if (!isRecord(raw)) return {}
  const metadata: MetadataMap = {}
  for (const id of BACKEND_MODEL_IDS) {
    const entry = parseMetadataEntry(raw[id])
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
  return { fetchedAt, metadata: parseMetadataMap(parsed.metadata) }
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
  return parseMetadataMap(data.openai.models)
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

function modelOverrideEnvVar(): string {
  return appInfo.name.toUpperCase().replace(/[^A-Z0-9]/g, "_") + "_MODEL"
}

export async function defaultModel(): Promise<string> {
  const override = process.env[modelOverrideEnvVar()]?.trim()
  if (override) return override
  return BACKEND_MODEL_IDS[0]!
}
