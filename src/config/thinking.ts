import type { Provider, ThinkingEffort, ThinkingOptions } from "../providers/types"
import { modelCatalog } from "../providers/catalog"
import { saveSettings, settings } from "./settings"

export async function thinkingOptions(provider: Provider, model: string): Promise<ThinkingOptions | undefined> {
  const catalog = await modelCatalog(provider)
  return catalog.models.find((info) => info.id === model)?.thinking
}

export async function resolveThinking(
  provider: Provider,
  model: string,
  preferred?: ThinkingEffort,
): Promise<ThinkingEffort | undefined> {
  const available = await thinkingOptions(provider, model)
  if (!available) return undefined
  const saved = preferred ?? settings().thinking[provider.id]?.[model]
  return saved && available.options.includes(saved) ? saved : available.default
}

export async function saveThinking(provider: Provider, model: string, effort: ThinkingEffort): Promise<void> {
  await saveSettings({
    thinking: {
      ...settings().thinking,
      [provider.id]: { ...settings().thinking[provider.id], [model]: effort },
    },
  })
}
