import type { ModelInfo } from "../../providers/types"

const LARGE_CONTEXT_MODEL = "gpt-5.6-sol"
const LARGE_CONTEXT_VARIANT = `${LARGE_CONTEXT_MODEL}-1m`

export function withLargeContextVariant(models: ModelInfo[]): ModelInfo[] {
  return models.flatMap((model) =>
    model.id === LARGE_CONTEXT_MODEL
      ? [
          model,
          {
            ...model,
            id: LARGE_CONTEXT_VARIANT,
            name: `${model.name} - 1M context`,
            contextWindow: 1_000_000,
            autoCompactTokenLimit: 900_000,
          },
        ]
      : [model],
  )
}

export function resolveLargeContextModel(model: string): string {
  return model === LARGE_CONTEXT_VARIANT ? LARGE_CONTEXT_MODEL : model
}
