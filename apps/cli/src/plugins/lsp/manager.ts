import { stat } from "node:fs/promises"
import { delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path"
import { describeError, isMissingPathError } from "../../lib/error"
import { isRecord, type JsonObject } from "../../lib/json"
import { compactPath, resolveFilePath } from "../../lib/path"
import { LspClient } from "./client"
import type { LspServerConfig, LspServerDefinition } from "./config"
import {
  firstCallHierarchyItem,
  formatCalls,
  formatDiagnostics,
  formatHover,
  formatLocations,
  formatSymbols,
} from "./format"

export type LspOperation =
  | "definition"
  | "references"
  | "hover"
  | "document_symbols"
  | "workspace_symbols"
  | "implementation"
  | "incoming_calls"
  | "outgoing_calls"
  | "diagnostics"

export interface LspQuery {
  operation: LspOperation
  filePath: string
  line?: number
  column?: number
  query?: string
}

interface ServerMatch {
  config: LspServerConfig
  languageId: string
  suffix: string
}

interface ClientFailure {
  server: string
  root: string
  reason: string
}

interface StartingClient {
  server: string
  run: Promise<LspClient>
  abort: AbortController
}

function clientKey(server: string, root: string): string {
  return `${server}\0${root}`
}

function searchPath(config: LspServerConfig): string | undefined {
  return config.env.PATH ?? process.env.PATH
}

function commandPath(config: LspServerConfig, cwd: string): string | undefined {
  const path = searchPath(config)
  const absolutePath = path
    ?.split(delimiter)
    .map((entry) => (isAbsolute(entry) ? entry : resolve(cwd, entry)))
    .join(delimiter)
  const executable = Bun.which(config.command, {
    cwd,
    ...(absolutePath === undefined ? {} : { PATH: absolutePath }),
  })
  if (!executable) return undefined
  return isAbsolute(executable) ? executable : resolve(cwd, executable)
}

function mayResolveFromAnotherRoot(config: LspServerConfig): boolean {
  if (isAbsolute(config.command)) return false
  return (
    searchPath(config)
      ?.split(delimiter)
      .some((entry) => !isAbsolute(entry)) ?? false
  )
}

function unavailableReason(config: LspServerConfig): string {
  const missing = isAbsolute(config.command)
    ? `${config.command} was not found or is not executable`
    : `${config.command} was not found on PATH`
  if (config.install) {
    return `${missing}. Install it with ${config.install} or override pluginConfig.lsp.servers.${config.id}.command`
  }
  return `${missing}. Set pluginConfig.lsp.servers.${config.id}.command to an executable name or absolute path`
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (isMissingPathError(error)) return false
    throw new Error(`Cannot inspect language-server root marker ${path}: ${describeError(error)}`, { cause: error })
  }
}

async function serverRoot(path: string, cwd: string, markers: string[]): Promise<string> {
  let directory = dirname(path)
  while (true) {
    if ((await Promise.all(markers.map((marker) => exists(join(directory, marker))))).some(Boolean)) return directory
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  const workingDirectory = resolve(cwd)
  const relativePath = relative(workingDirectory, path)
  if (!relativePath.startsWith("..") && !isAbsolute(relativePath)) return workingDirectory
  return dirname(path)
}

function position(query: LspQuery): JsonObject {
  if (query.line === undefined || query.column === undefined) {
    throw new Error(`${query.operation} requires line and column`)
  }
  return { line: query.line - 1, character: query.column - 1 }
}

function documentPosition(uri: string, query: LspQuery): JsonObject {
  return { textDocument: { uri }, position: position(query) }
}

function supportsPullDiagnostics(capabilities: unknown): boolean {
  return (
    isRecord(capabilities) && capabilities.diagnosticProvider !== undefined && capabilities.diagnosticProvider !== false
  )
}

function pullDiagnosticItems(value: unknown): unknown[] {
  if (!isRecord(value) || !Array.isArray(value.items)) {
    throw new Error("language server returned malformed pull diagnostics")
  }
  return value.items
}

export class LspManager {
  private readonly definitions: LspServerDefinition[]
  private readonly configs: LspServerConfig[]
  private readonly clients = new Map<string, LspClient>()
  private readonly starting = new Map<string, StartingClient>()
  private readonly failures = new Map<string, ClientFailure>()
  private readonly closeController = new AbortController()
  private closing = false
  private closeRun: Promise<void> | undefined
  private restartRun: Promise<void> | undefined

  constructor(definitions: LspServerDefinition[]) {
    this.definitions = definitions
    this.configs = definitions.flatMap((definition) => (definition.state === "enabled" ? [definition.server] : []))
  }

  hasAvailableServer(cwd = process.cwd()): boolean {
    if (this.clients.size > 0 || this.starting.size > 0) return true
    return this.configs.some((config) => commandPath(config, cwd) !== undefined || mayResolveFromAnotherRoot(config))
  }

  statusLines(cwd = process.cwd()): string[] {
    if (this.definitions.length === 0) return ["No language servers configured."]
    return this.definitions.flatMap((definition) => {
      if (definition.state === "disabled") return [`${definition.id} · disabled`]
      const config = definition.server
      const active = [...this.clients.values()].filter((client) => client.id === config.id)
      const failed = [...this.failures.values()].filter((failure) => failure.server === config.id)
      if (active.length === 0 && failed.length === 0) {
        if (!commandPath(config, cwd)) {
          return [
            `${config.id} · unavailable · ${Object.keys(config.fileTypes).join(", ")} · ${unavailableReason(config)}`,
          ]
        }
        return [`${config.id} · idle · ${Object.keys(config.fileTypes).join(", ")} · ${config.command}`]
      }
      return [
        ...active.map((client) =>
          [
            config.id,
            client.status,
            compactPath(client.root),
            ...(client.failure === undefined ? [] : [describeError(client.failure)]),
            ...(client.stderr ? [client.stderr] : []),
          ].join(" · "),
        ),
        ...failed.map((failure) => `${config.id} · failed · ${compactPath(failure.root)} · ${failure.reason}`),
      ]
    })
  }

  async restart(server?: string): Promise<void> {
    if (this.closing) throw new Error("language server manager is shutting down")
    if (server) {
      const definition = this.definitions.find((candidate) =>
        candidate.state === "enabled" ? candidate.server.id === server : candidate.id === server,
      )
      if (!definition) throw new Error(`unknown language server: ${server}`)
      if (definition.state === "disabled") throw new Error(`language server is disabled: ${server}`)
    }

    const previous = this.restartRun
    const run = (previous ? previous.catch(() => undefined) : Promise.resolve()).then(() => this.runRestart(server))
    const tracked = run.finally(() => {
      if (this.restartRun === tracked) this.restartRun = undefined
    })
    this.restartRun = tracked
    return tracked
  }

  private async runRestart(server: string | undefined): Promise<void> {
    const starting = [...this.starting.values()].filter((entry) => !server || entry.server === server)
    for (const entry of starting) entry.abort.abort(new Error(`LSP server ${entry.server} is restarting`))
    await Promise.allSettled(starting.map((entry) => entry.run))

    const clients = [...this.clients.entries()].filter(([, client]) => !server || client.id === server)
    const outcomes = await Promise.allSettled(clients.map(([, client]) => client.close()))
    for (const [key] of clients) this.clients.delete(key)
    for (const [key, failure] of this.failures) {
      if (!server || failure.server === server) this.failures.delete(key)
    }
    const errors = outcomes.flatMap((outcome) => (outcome.status === "rejected" ? [describeError(outcome.reason)] : []))
    if (errors.length > 0) throw new Error(`language server restart failed: ${errors.join("; ")}`)
  }

  close(): Promise<void> {
    this.closeRun ??= this.runClose()
    return this.closeRun
  }

  private async runClose(): Promise<void> {
    this.closing = true
    this.closeController.abort(new Error("language server manager is shutting down"))
    if (this.restartRun) await Promise.allSettled([this.restartRun])
    await Promise.allSettled([...this.starting.values()].map((entry) => entry.run))
    const outcomes = await Promise.allSettled([...this.clients.values()].map((client) => client.close()))
    this.clients.clear()
    this.starting.clear()
    const errors = outcomes.flatMap((outcome) => (outcome.status === "rejected" ? [describeError(outcome.reason)] : []))
    if (errors.length > 0) throw new Error(`language server shutdown failed: ${errors.join("; ")}`)
  }

  async query(query: LspQuery, cwd: string, signal?: AbortSignal): Promise<string> {
    if (this.closing) throw new Error("language server manager is shutting down")
    const path = resolveFilePath(query.filePath, cwd)
    let fileStats
    try {
      fileStats = await stat(path)
    } catch (error) {
      if (isMissingPathError(error)) {
        throw new Error(`File not found: ${query.filePath}`, { cause: error })
      }
      throw new Error(`Cannot inspect ${query.filePath}: ${describeError(error)}`, { cause: error })
    }
    if (!fileStats.isFile()) throw new Error(`Path is not a file: ${query.filePath}`)

    const match = this.match(path)
    const root = await serverRoot(path, cwd, match.config.rootMarkers)
    const client = await this.client(match.config, root, match.suffix, signal)
    try {
      return await this.queryClient(client, match.languageId, path, query, cwd, signal)
    } catch (error) {
      if (client.status === "failed" || (client.status === "closed" && client.failure !== undefined)) {
        const key = clientKey(match.config.id, root)
        const failure = client.failure ?? error
        this.clients.delete(key)
        this.failures.set(key, { server: match.config.id, root, reason: describeError(failure) })
        throw new Error(`LSP server ${match.config.id} failed: ${describeError(failure)}`, { cause: error })
      }
      throw error
    }
  }

  private match(path: string): ServerMatch {
    let selected: ServerMatch | undefined
    let selectedLength = -1
    for (const config of this.configs) {
      for (const [suffix, languageId] of Object.entries(config.fileTypes)) {
        if (!path.endsWith(suffix) || suffix.length <= selectedLength) continue
        selected = { config, languageId, suffix }
        selectedLength = suffix.length
      }
    }
    if (selected) return selected
    throw new Error(`no language server supports ${path}; configure pluginConfig.lsp.servers`)
  }

  private async client(
    config: LspServerConfig,
    root: string,
    suffix: string,
    signal?: AbortSignal,
  ): Promise<LspClient> {
    if (this.closing) throw new Error("language server manager is shutting down")
    while (this.restartRun) {
      await this.restartRun
      if (this.closing) throw new Error("language server manager is shutting down")
    }
    const key = clientKey(config.id, root)
    const current = this.clients.get(key)
    if (current) return current
    const pending = this.starting.get(key)
    if (pending) return pending.run

    const command = commandPath(config, root)
    if (!command) {
      throw new Error(`LSP server ${config.id} is unavailable for ${suffix}: ${unavailableReason(config)}`)
    }
    const abort = new AbortController()
    const starting = LspClient.start({
      id: config.id,
      root,
      command,
      args: config.args,
      env: config.env,
      timeoutMs: config.timeoutMs,
      ...(config.initializationOptions ? { initializationOptions: config.initializationOptions } : {}),
      ...(config.settings ? { settings: config.settings } : {}),
      signal: AbortSignal.any([abort.signal, this.closeController.signal, ...(signal === undefined ? [] : [signal])]),
    })
    this.starting.set(key, { server: config.id, run: starting, abort })
    try {
      const client = await starting
      this.clients.set(key, client)
      this.failures.delete(key)
      return client
    } catch (error) {
      this.failures.set(key, { server: config.id, root, reason: describeError(error) })
      throw error
    } finally {
      this.starting.delete(key)
    }
  }

  private async queryClient(
    client: LspClient,
    languageId: string,
    path: string,
    query: LspQuery,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const synced = await client.syncDocument(path, languageId, signal)
    if (synced.changed && query.operation !== "diagnostics") {
      await client.waitForDiagnostics(path, synced.version, 1_500, signal)
    }
    const at = (): JsonObject => documentPosition(synced.uri, query)
    switch (query.operation) {
      case "definition":
        return formatLocations(await client.request("textDocument/definition", at(), signal), cwd, "definition")
      case "references":
        return formatLocations(
          await client.request("textDocument/references", { ...at(), context: { includeDeclaration: true } }, signal),
          cwd,
          "reference",
        )
      case "hover":
        return formatHover(await client.request("textDocument/hover", at(), signal))
      case "document_symbols":
        return formatSymbols(
          await client.request("textDocument/documentSymbol", { textDocument: { uri: synced.uri } }, signal),
          cwd,
          synced.uri,
        )
      case "workspace_symbols":
        return formatSymbols(
          await client.request("workspace/symbol", { query: query.query ?? "" }, signal),
          cwd,
          synced.uri,
        )
      case "implementation":
        return formatLocations(await client.request("textDocument/implementation", at(), signal), cwd, "implementation")
      case "incoming_calls":
      case "outgoing_calls": {
        const prepared = firstCallHierarchyItem(await client.request("textDocument/prepareCallHierarchy", at(), signal))
        if (!prepared) return `No ${query.operation === "incoming_calls" ? "incoming" : "outgoing"} calls found`
        const direction = query.operation === "incoming_calls" ? "incoming" : "outgoing"
        return formatCalls(
          await client.request(`callHierarchy/${direction}Calls`, { item: prepared }, signal),
          cwd,
          direction,
        )
      }
      case "diagnostics": {
        if (supportsPullDiagnostics(client.capabilities)) {
          const result = await client.request("textDocument/diagnostic", { textDocument: { uri: synced.uri } }, signal)
          return formatDiagnostics(pullDiagnosticItems(result), synced.uri, cwd)
        }
        const published = await client.waitForDiagnostics(path, synced.version, 1_500, signal)
        if (!published) return "No diagnostics received from the language server before the 1.5s deadline"
        return formatDiagnostics(client.diagnosticsFor(path), synced.uri, cwd)
      }
    }
  }
}
