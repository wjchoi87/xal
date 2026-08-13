import { join } from "node:path"
import { readJsonFile, writeSecureJson } from "../lib/fs"
import { asString, asStringArray, isRecord } from "../lib/json"
import { findProjectRoot } from "../project/root"
import { isTrusted } from "../project/trust"
import { isThinkingEffort, type ThinkingEffort } from "../providers/types"
import { agentHome, projectConfigPath } from "./paths"

export interface PermissionSettings {
  allow: string[]
  ask: string[]
  deny: string[]
}

export interface ModeSettings {
  base?: string
  allow: string[]
  ask: string[]
  deny: string[]
  guidance?: string
}

export interface RedactionSettings {
  values: string[]
  environment: string[]
}

export interface Settings {
  plugins: string[]
  provider?: string
  model?: string
  ui?: string
  permissions: PermissionSettings
  modes: Record<string, ModeSettings>
  redaction: RedactionSettings
  pluginConfig: Record<string, Record<string, unknown>>
  thinking: Record<string, Record<string, ThinkingEffort>>
}

let current: Settings = {
  plugins: [],
  permissions: { allow: [], ask: [], deny: [] },
  modes: {},
  redaction: { values: [], environment: [] },
  pluginConfig: {},
  thinking: {},
}

function userSettingsPath(): string {
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
  const path = userSettingsPath()
  const [user, project] = await Promise.all([readSettingsFile(path), readProjectSettings()])
  const nextUser = mergeSettings(user, { ...patch })
  const next = parseSettings(mergeSettings(nextUser, project))
  await writeSecureJson(path, nextUser)
  current = next
}

async function readSettings(): Promise<Settings> {
  const [user, project] = await Promise.all([readSettingsFile(userSettingsPath()), readProjectSettings()])
  return parseSettings(mergeSettings(user, project))
}

async function readProjectSettings(): Promise<Record<string, unknown>> {
  const root = await findProjectRoot(process.cwd())
  if (!(await isTrusted(root))) return {}
  return readSettingsFile(projectConfigPath(root))
}

async function readSettingsFile(path: string): Promise<Record<string, unknown>> {
  const raw = await readJsonFile(path)
  if (raw === undefined) return {}
  if (!isRecord(raw)) {
    throw new Error(`${path} is malformed — fix or delete it`)
  }
  return raw
}

function mergeSettings(lower: Record<string, unknown>, higher: Record<string, unknown>): Record<string, unknown> {
  const merged = { ...lower }
  for (const [key, value] of Object.entries(higher)) {
    const previous = merged[key]
    merged[key] = isRecord(previous) && isRecord(value) ? mergeSettings(previous, value) : value
  }
  return merged
}

function sectionRecord(raw: Record<string, unknown>, field: string): Record<string, unknown> {
  const value = raw[field]
  if (value === undefined) return {}
  if (!isRecord(value)) throw new Error(`${field} must be an object`)
  return value
}

function strictStringArray(value: unknown, path: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || asStringArray(value).length !== value.length) {
    throw new Error(`${path} must be an array of strings`)
  }
  return asStringArray(value)
}

function parseSettings(raw: Record<string, unknown>): Settings {
  const plugins = asStringArray(raw.plugins)
  const permissions = sectionRecord(raw, "permissions")
  const modes: Record<string, ModeSettings> = {}
  for (const [name, value] of Object.entries(sectionRecord(raw, "modes"))) {
    if (!isRecord(value)) throw new Error(`modes.${name} must be an object`)
    modes[name] = {
      base: asString(value.base),
      allow: strictStringArray(value.allow, `modes.${name}.allow`),
      ask: strictStringArray(value.ask, `modes.${name}.ask`),
      deny: strictStringArray(value.deny, `modes.${name}.deny`),
      guidance: asString(value.guidance),
    }
  }
  const redaction = sectionRecord(raw, "redaction")
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
    permissions: {
      allow: strictStringArray(permissions.allow, "permissions.allow"),
      ask: strictStringArray(permissions.ask, "permissions.ask"),
      deny: strictStringArray(permissions.deny, "permissions.deny"),
    },
    modes,
    redaction: {
      values: strictStringArray(redaction.values, "redaction.values"),
      environment: strictStringArray(redaction.environment, "redaction.environment"),
    },
    pluginConfig,
    thinking,
  }
}
