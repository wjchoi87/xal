import { asString, isRecord } from "../../lib/json"
import type { ModelInfo, ThinkingOptions } from "../../providers/types"
import { deepSeekFetch } from "./api"
import { apiKey } from "./auth"

function modelInfo(id: string): ModelInfo {
  if (id === "deepseek-v4-flash") {
    return { id, name: "DeepSeek V4 Flash", contextWindow: 1_000_000, maxOutput: 384_000, reasoning: true }
  }
  if (id === "deepseek-v4-pro") {
    return { id, name: "DeepSeek V4 Pro", contextWindow: 1_000_000, maxOutput: 384_000, reasoning: true }
  }
  return { id, name: id }
}

export async function listModels(): Promise<ModelInfo[]> {
  const response = await deepSeekFetch("/models", await apiKey(), { signal: AbortSignal.timeout(15_000) })
  const raw: unknown = await response.json()
  if (!isRecord(raw) || !Array.isArray(raw.data)) throw new Error("DeepSeek models response was invalid")
  return raw.data.flatMap((entry) => {
    if (!isRecord(entry)) return []
    const id = asString(entry.id)
    return id ? [modelInfo(id)] : []
  })
}

export async function defaultModel(): Promise<string> {
  return "deepseek-v4-flash"
}

export async function thinking(model: string): Promise<ThinkingOptions | undefined> {
  if (model === "deepseek-v4-flash") return { options: ["none", "low", "high", "max"], default: "high" }
  if (model === "deepseek-v4-pro") return { options: ["none", "high", "max"], default: "high" }
  return undefined
}
