import { saveSettings } from "../../config/settings"
import { asBoolean } from "../../lib/json"

export interface TuiConfig {
  showOutputs: boolean
  showThinking: boolean
}

export type TuiConfigKey = keyof TuiConfig

function booleanOption(raw: Record<string, unknown>, key: TuiConfigKey): boolean {
  if (!Object.hasOwn(raw, key)) return false
  const value = asBoolean(raw[key])
  if (value === undefined) throw new Error(`tui ${key} must be a boolean`)
  return value
}

export function parseTuiConfig(raw: Record<string, unknown>): TuiConfig {
  return {
    showOutputs: booleanOption(raw, "showOutputs"),
    showThinking: booleanOption(raw, "showThinking"),
  }
}

export function saveTuiConfig(config: TuiConfig): Promise<void> {
  return saveSettings({
    pluginConfig: {
      tui: { ...config },
    },
  })
}
