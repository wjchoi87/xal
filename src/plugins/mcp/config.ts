import { resolve } from "node:path"
import { isRecord } from "../../lib/json"

interface McpServerBase {
  id: string
  enabled: boolean
  timeoutMs: number
}

export interface McpStdioServerConfig extends McpServerBase {
  transport: "stdio"
  command: string
  args: string[]
  env: Record<string, string>
  cwd?: string
}

export interface McpHttpServerConfig extends McpServerBase {
  transport: "http"
  url: string
  headers: Record<string, string>
}

export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig

export interface McpConfig {
  servers: McpServerConfig[]
  secrets: string[]
}

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

function stringArray(value: unknown, path: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    invalid(path, "an array of strings")
  }
  return value
}

function stringRecord(value: unknown, path: string): Record<string, string> {
  if (value === undefined) return {}
  if (!isRecord(value)) invalid(path, "an object of string values")
  const result: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (key.length === 0 || typeof entry !== "string") invalid(path, "an object of string values")
    result[key] = entry
  }
  return result
}

function enabledValue(value: unknown, path: string): boolean {
  if (value === undefined) return true
  if (typeof value !== "boolean") invalid(path, "a boolean")
  return value
}

function timeoutValue(value: unknown, path: string): number {
  if (value === undefined) return 30_000
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    invalid(path, "a positive integer")
  }
  return value
}

function secretKey(name: string): boolean {
  return /(authorization|cookie|credential|password|secret|token|api[-_]?key)/i.test(name)
}

function expand(value: string, path: string, secrets: Set<string>, sensitive = false): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
    const resolved = process.env[name]
    if (resolved === undefined) throw new Error(`${path} references missing environment variable ${name}`)
    if (sensitive || secretKey(name)) secrets.add(resolved)
    return resolved
  })
}

function expandRecord(values: Record<string, string>, path: string, secrets: Set<string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => {
      const sensitive = secretKey(key)
      const expanded = expand(value, `${path}.${key}`, secrets, sensitive)
      if (sensitive) secrets.add(expanded)
      return [key, expanded]
    }),
  )
}

function parseServer(id: string, value: unknown, secrets: Set<string>): McpServerConfig {
  const path = `pluginConfig.mcp.servers.${id}`
  if (!/^[a-z][a-z0-9_-]*$/.test(id)) {
    throw new Error(`${path} has an invalid server name; use lower-case letters, numbers, hyphens, and underscores`)
  }
  if (!isRecord(value)) invalid(path, "an object")

  const transport = value.transport
  const base = {
    id,
    enabled: enabledValue(value.enabled, `${path}.enabled`),
    timeoutMs: timeoutValue(value.timeoutMs, `${path}.timeoutMs`),
  }

  if (transport === "stdio") {
    exactKeys(value, path, ["transport", "command", "args", "cwd", "env", "url", "headers", "enabled", "timeoutMs"])
    const command = expand(stringValue(value.command, `${path}.command`), `${path}.command`, secrets)
    const args = stringArray(value.args, `${path}.args`).map((entry, index) =>
      expand(entry, `${path}.args[${index}]`, secrets),
    )
    const cwd = value.cwd === undefined ? undefined : stringValue(value.cwd, `${path}.cwd`)
    return {
      ...base,
      transport,
      command,
      args,
      env: expandRecord(stringRecord(value.env, `${path}.env`), `${path}.env`, secrets),
      ...(cwd ? { cwd: resolve(process.cwd(), expand(cwd, `${path}.cwd`, secrets)) } : {}),
    }
  }

  if (transport === "http") {
    exactKeys(value, path, ["transport", "url", "headers", "command", "args", "cwd", "env", "enabled", "timeoutMs"])
    const url = expand(stringValue(value.url, `${path}.url`), `${path}.url`, secrets)
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
      ...base,
      transport,
      url,
      headers: expandRecord(stringRecord(value.headers, `${path}.headers`), `${path}.headers`, secrets),
    }
  }

  throw new Error(`${path}.transport must be "stdio" or "http"`)
}

export function parseMcpConfig(value: Record<string, unknown>): McpConfig {
  exactKeys(value, "pluginConfig.mcp", ["servers"])
  if (value.servers === undefined) return { servers: [], secrets: [] }
  if (!isRecord(value.servers)) invalid("pluginConfig.mcp.servers", "an object")
  const secrets = new Set<string>()
  return {
    servers: Object.entries(value.servers).map(([id, server]) => parseServer(id, server, secrets)),
    secrets: [...secrets],
  }
}
