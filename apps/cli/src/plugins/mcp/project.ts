import { readJsonFile, writeSecureJson } from "../../lib/fs"
import { isRecord } from "../../lib/json"
import { isTrusted } from "../../project/trust"
import { projectConfigPath, projectMcpConfigPath, userConfigPath } from "../../config/paths"
import { loadSettings, type Settings } from "../../config/settings"

export type McpConfigSource = "session" | "project" | "global"

export interface ProjectMcpIo {
  print(line: string): void
  choose?(options: string[]): Promise<number | undefined>
}

type ServerDefinitions = Record<string, Record<string, unknown>>

function invalid(path: string, expected: string): never {
  throw new Error(`${path} must be ${expected}`)
}

function exactKeys(value: Record<string, unknown>, path: string, allowed: string[]): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key))
  if (unknown) throw new Error(`${path}.${unknown} is not supported`)
}

function stringValue(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) invalid(path, "a non-empty string")
  return value
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined
  return stringValue(value, path)
}

function stringArray(value: unknown, path: string): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    invalid(path, "an array of strings")
  }
  return value
}

function stringRecord(value: unknown, path: string): Record<string, string> | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) invalid(path, "an object of string values")
  const result: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (!key || typeof entry !== "string") invalid(path, "an object of string values")
    result[key] = entry
  }
  return result
}

function enabledValue(value: unknown, path: string): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "boolean") invalid(path, "a boolean")
  return value
}

function timeoutValue(value: unknown, path: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    invalid(path, "a positive integer")
  }
  return value
}

function parseServer(id: string, value: unknown): Record<string, unknown> {
  const path = `.mcp.json.mcpServers.${id}`
  if (!/^[a-z][a-z0-9_-]*$/.test(id)) {
    throw new Error(`${path} has an invalid server name; use lower-case letters, numbers, hyphens, and underscores`)
  }
  if (!isRecord(value)) invalid(path, "an object")

  const type = value.type ?? (value.url === undefined ? "stdio" : "http")
  const enabled = enabledValue(value.enabled, `${path}.enabled`)
  const timeoutMs = timeoutValue(value.timeoutMs, `${path}.timeoutMs`)

  if (type === "stdio") {
    exactKeys(value, path, ["type", "command", "args", "cwd", "env", "enabled", "timeoutMs"])
    const args = stringArray(value.args, `${path}.args`)
    const cwd = optionalString(value.cwd, `${path}.cwd`)
    const env = stringRecord(value.env, `${path}.env`)
    return {
      transport: "stdio",
      command: stringValue(value.command, `${path}.command`),
      ...(args ? { args } : {}),
      ...(cwd ? { cwd } : {}),
      ...(env ? { env } : {}),
      ...(enabled === undefined ? {} : { enabled }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    }
  }

  if (type === "http" || type === "streamable-http") {
    exactKeys(value, path, ["type", "url", "headers", "enabled", "timeoutMs"])
    const headers = stringRecord(value.headers, `${path}.headers`)
    const url = stringValue(value.url, `${path}.url`)
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      throw new Error(`${path}.url must be a valid URL`)
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`${path}.url must use http or https`)
    }
    return {
      transport: "http",
      url,
      ...(headers ? { headers } : {}),
      ...(enabled === undefined ? {} : { enabled }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    }
  }

  throw new Error(`${path}.type must be "stdio", "http", or "streamable-http"`)
}

export function parseProjectMcpConfig(value: unknown): ServerDefinitions {
  if (!isRecord(value)) invalid(".mcp.json", "an object")
  exactKeys(value, ".mcp.json", ["mcpServers"])
  if (!isRecord(value.mcpServers)) invalid(".mcp.json.mcpServers", "an object")
  return Object.fromEntries(Object.entries(value.mcpServers).map(([id, server]) => [id, parseServer(id, server)]))
}

function configuredServerNames(settings: Settings): Set<string> {
  const mcp = settings.pluginConfig.mcp
  if (!mcp || mcp.servers === undefined) return new Set()
  if (!isRecord(mcp.servers)) invalid("pluginConfig.mcp.servers", "an object")
  return new Set(Object.keys(mcp.servers))
}

function withServers(settings: Settings, servers: ServerDefinitions): Settings {
  const mcp = settings.pluginConfig.mcp ?? {}
  const configured = isRecord(mcp.servers) ? mcp.servers : {}
  return {
    ...settings,
    pluginConfig: {
      ...settings.pluginConfig,
      mcp: { ...mcp, servers: { ...configured, ...servers } },
    },
  }
}

async function readConfig(path: string): Promise<Record<string, unknown>> {
  const value = await readJsonFile(path)
  if (value === undefined) return {}
  if (!isRecord(value)) throw new Error(`${path} is malformed — fix or delete it`)
  return value
}

function rawServers(config: Record<string, unknown>, path: string): Record<string, unknown> {
  if (config.pluginConfig === undefined) return {}
  if (!isRecord(config.pluginConfig)) invalid(`${path}.pluginConfig`, "an object")
  if (config.pluginConfig.mcp === undefined) return {}
  if (!isRecord(config.pluginConfig.mcp)) invalid(`${path}.pluginConfig.mcp`, "an object")
  if (config.pluginConfig.mcp.servers === undefined) return {}
  if (!isRecord(config.pluginConfig.mcp.servers)) invalid(`${path}.pluginConfig.mcp.servers`, "an object")
  return config.pluginConfig.mcp.servers
}

async function addServers(path: string, additions: ServerDefinitions): Promise<void> {
  const config = await readConfig(path)
  const existing = rawServers(config, path)
  const pluginConfig = isRecord(config.pluginConfig) ? config.pluginConfig : {}
  const mcp = isRecord(pluginConfig.mcp) ? pluginConfig.mcp : {}
  await writeSecureJson(path, {
    ...config,
    pluginConfig: {
      ...pluginConfig,
      mcp: { ...mcp, servers: { ...additions, ...existing } },
    },
  })
}

export async function prepareProjectMcp(root: string, settings: Settings, io: ProjectMcpIo): Promise<Settings> {
  if (!(await isTrusted(root))) return settings
  const path = projectMcpConfigPath(root)
  const value = await readJsonFile(path)
  if (value === undefined) return settings
  const discovered = parseProjectMcpConfig(value)
  const configured = configuredServerNames(settings)
  const additions = Object.fromEntries(Object.entries(discovered).filter(([id]) => !configured.has(id)))
  const names = Object.keys(additions)
  if (names.length === 0) return settings

  const conflicts = Object.keys(discovered).filter((id) => configured.has(id))
  io.print(`Detected ${path} with ${names.length} new MCP server${names.length === 1 ? "" : "s"}.`)
  if (conflicts.length > 0) io.print(`Keeping existing Xal configuration for: ${conflicts.join(", ")}`)

  if (!io.choose) {
    io.print(`Ignoring unapproved MCP servers from ${path}; launch interactively to use or import them.`)
    return settings
  }

  const choice = await io.choose(["Use for this session", "Add to this project", "Add globally", "Do not use"])
  if (choice === 0) return withServers(settings, additions)
  if (choice === 1) {
    await addServers(projectConfigPath(root), additions)
    return loadSettings()
  }
  if (choice === 2) {
    await addServers(userConfigPath(), additions)
    return loadSettings()
  }
  return settings
}

async function removeServer(path: string, id: string): Promise<boolean> {
  const config = await readConfig(path)
  const servers = rawServers(config, path)
  if (!Object.hasOwn(servers, id)) return false
  const pluginConfig = config.pluginConfig
  if (!isRecord(pluginConfig)) throw new Error(`${path}.pluginConfig must be an object`)
  const mcp = pluginConfig.mcp
  if (!isRecord(mcp)) throw new Error(`${path}.pluginConfig.mcp must be an object`)
  const nextServers = { ...servers }
  delete nextServers[id]
  await writeSecureJson(path, {
    ...config,
    pluginConfig: {
      ...pluginConfig,
      mcp: { ...mcp, servers: nextServers },
    },
  })
  return true
}

export async function deleteMcpServer(root: string, id: string): Promise<McpConfigSource> {
  if (await removeServer(projectConfigPath(root), id)) return "project"
  if (await removeServer(userConfigPath(), id)) return "global"
  return "session"
}
