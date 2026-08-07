import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { asString, isRecord } from "../lib/json"
import { agentHome } from "./paths"

export interface Settings {
  plugins: string[]
  provider?: string
  model?: string
  ui?: string
  pluginConfig: Record<string, Record<string, unknown>>
}

let current: Settings = { plugins: [], pluginConfig: {} }

export function settingsPath(): string {
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
    try {
      const parsed: unknown = await file.json()
      if (isRecord(parsed)) raw = parsed
    } catch {}
  }
  await mkdir(agentHome(), { recursive: true })
  await Bun.write(settingsPath(), JSON.stringify({ ...raw, ...patch }, null, 2) + "\n")
  current = { ...current, ...patch }
}

async function readSettings(): Promise<Settings> {
  const fallback: Settings = { plugins: [], pluginConfig: {} }
  const file = Bun.file(settingsPath())
  if (!(await file.exists())) return fallback

  let raw: unknown
  try {
    raw = await file.json()
  } catch {
    return fallback
  }
  if (!isRecord(raw)) return fallback

  const plugins = Array.isArray(raw.plugins)
    ? raw.plugins.flatMap((entry) => (typeof entry === "string" ? [entry] : []))
    : []
  const pluginConfig: Record<string, Record<string, unknown>> = {}
  if (isRecord(raw.pluginConfig)) {
    for (const [name, value] of Object.entries(raw.pluginConfig)) {
      if (isRecord(value)) pluginConfig[name] = value
    }
  }
  return {
    plugins,
    provider: asString(raw.provider),
    model: asString(raw.model),
    ui: asString(raw.ui),
    pluginConfig,
  }
}
