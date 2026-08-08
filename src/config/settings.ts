import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { asString, asStringArray, isRecord } from "../lib/json"
import { isThinkingEffort, type ThinkingEffort } from "../providers/types"
import { agentHome } from "./paths"

export interface Settings {
  plugins: string[]
  provider?: string
  model?: string
  ui?: string
  pluginConfig: Record<string, Record<string, unknown>>
  thinking: Record<string, Record<string, ThinkingEffort>>
}

let current: Settings = { plugins: [], pluginConfig: {}, thinking: {} }

function settingsPath(): string {
  return join(agentHome(), "config.json")
}

export function settings(): Settings {
  return current
}

export async function loadSettings(): Promise<Settings> {
  current = await readSettings()
  return current
}

export async function saveSettings(patch: Partial<Settings>): Promise<void> {
  let raw: Record<string, unknown> = {}
  const file = Bun.file(settingsPath())
  if (await file.exists()) {
    const parsed: unknown = await file.json().catch(() => undefined)
    if (!isRecord(parsed)) {
      throw new Error(`${settingsPath()} is malformed — fix or delete it before changing settings`)
    }
    raw = parsed
  }
  await mkdir(agentHome(), { recursive: true })
  await Bun.write(settingsPath(), JSON.stringify({ ...raw, ...patch }, null, 2) + "\n")
  current = { ...current, ...patch }
}

async function readSettings(): Promise<Settings> {
  const file = Bun.file(settingsPath())
  if (!(await file.exists())) return { plugins: [], pluginConfig: {}, thinking: {} }

  const raw: unknown = await file.json().catch(() => undefined)
  if (!isRecord(raw)) {
    throw new Error(`${settingsPath()} is malformed — fix or delete it`)
  }

  const plugins = asStringArray(raw.plugins)
  const pluginConfig: Record<string, Record<string, unknown>> = {}
  if (isRecord(raw.pluginConfig)) {
    for (const [name, value] of Object.entries(raw.pluginConfig)) {
      if (isRecord(value)) pluginConfig[name] = value
    }
  }
  const thinking: Record<string, Record<string, ThinkingEffort>> = {}
  if (isRecord(raw.thinking)) {
    for (const [provider, models] of Object.entries(raw.thinking)) {
      if (!isRecord(models)) continue
      const efforts: Record<string, ThinkingEffort> = {}
      for (const [model, value] of Object.entries(models)) {
        if (isThinkingEffort(value)) efforts[model] = value
      }
      thinking[provider] = efforts
    }
  }
  return {
    plugins,
    provider: asString(raw.provider),
    model: asString(raw.model),
    ui: asString(raw.ui),
    pluginConfig,
    thinking,
  }
}
