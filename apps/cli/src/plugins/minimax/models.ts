import type { ModelCatalog, ModelInfo } from "../../providers/types"

export interface MiniMaxModel extends ModelInfo {
  maxOutputTokens: number
}

const BUNDLED_MODELS: MiniMaxModel[] = [
  {
    id: "MiniMax-M3",
    name: "MiniMax M3",
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    inputModalities: ["text", "image"],
    thinking: { options: ["none", "high"], default: "high" },
  },
  {
    id: "MiniMax-M2.7",
    name: "MiniMax M2.7",
    contextWindow: 204_800,
    maxOutputTokens: 131_072,
    inputModalities: ["text"],
  },
  {
    id: "MiniMax-M2.7-highspeed",
    name: "MiniMax M2.7 Highspeed",
    contextWindow: 204_800,
    maxOutputTokens: 131_072,
    inputModalities: ["text"],
  },
  {
    id: "MiniMax-M2.5",
    name: "MiniMax M2.5",
    contextWindow: 204_800,
    maxOutputTokens: 131_072,
    inputModalities: ["text"],
  },
  {
    id: "MiniMax-M2.5-highspeed",
    name: "MiniMax M2.5 Highspeed",
    contextWindow: 204_800,
    maxOutputTokens: 131_072,
    inputModalities: ["text"],
  },
  {
    id: "MiniMax-M2.1",
    name: "MiniMax M2.1",
    contextWindow: 204_800,
    maxOutputTokens: 131_072,
    inputModalities: ["text"],
  },
  {
    id: "MiniMax-M2",
    name: "MiniMax M2",
    contextWindow: 196_608,
    maxOutputTokens: 128_000,
    inputModalities: ["text"],
  },
]

export function resolveModel(id: string): MiniMaxModel {
  return (
    BUNDLED_MODELS.find((model) => model.id === id) ?? {
      id,
      name: id,
      maxOutputTokens: 131_072,
      inputModalities: ["text"],
    }
  )
}

export async function listModels(): Promise<ModelCatalog> {
  return { models: BUNDLED_MODELS, source: "bundled" }
}

export async function defaultModel(): Promise<string> {
  return BUNDLED_MODELS[0]!.id
}
