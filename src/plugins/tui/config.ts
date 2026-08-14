import { saveSettings } from "../../config/settings"
import { asBoolean } from "../../lib/json"
import { parseShortcutOverrides, type ShortcutOverrides } from "./shortcuts"

export interface TuiPreferences {
  showOutputs: boolean
  showThinking: boolean
}

export interface TuiConfig extends TuiPreferences {
  keybindings: ShortcutOverrides
}

export type TuiConfigKey = keyof TuiPreferences

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
    keybindings: parseShortcutOverrides(raw.keybindings),
  }
}

export function saveTuiConfig(config: TuiPreferences): Promise<void> {
  return saveSettings({
    pluginConfig: {
      tui: { ...config },
    },
  })
}
