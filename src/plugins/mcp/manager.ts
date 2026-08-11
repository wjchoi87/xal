import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js"
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import {
  CompatibilityCallToolResultSchema,
  ListToolsResultSchema,
  type Prompt,
  type Resource,
  type ResourceTemplate,
  type Tool as McpTool,
} from "@modelcontextprotocol/sdk/types.js"
import Ajv from "ajv"
import Ajv2019 from "ajv/dist/2019.js"
import Ajv2020, { type ValidateFunction } from "ajv/dist/2020.js"
import addFormats from "ajv-formats"
import { appInfo } from "../../app-info"
import { describeError } from "../../lib/error"
import type { RegisteredTool, Tool } from "../../tools/types"
import type { McpServerConfig } from "./config"
import { formatJson, formatPromptResult, formatResourceContent, formatToolResult } from "./format"

type ConnectionTransport = "stdio" | "http" | "sse"
type ConnectionState = "disabled" | "idle" | "connecting" | "connected" | "failed"

interface McpToolRegistry {
  register(tool: RegisteredTool): void
  unregister(tool: RegisteredTool): void
}

interface ServerEntry {
  config: McpServerConfig
  state: ConnectionState
  generation: number
  client?: Client
  connectionTransport?: ConnectionTransport
  tools: McpTool[]
  resources: Resource[]
  resourceTemplates: ResourceTemplate[]
  prompts: Prompt[]
  registeredTools: RegisteredTool[]
  pendingConnect?: Promise<void>
  connectingClient?: Client
  connectAbort?: AbortController
  toolRevision: number
  resourceRevision: number
  promptRevision: number
  skippedTaskTools: string[]
  skippedOutputTools: string[]
  toolValidators: Map<McpTool, OutputValidator | undefined>
  instructions?: string
  error?: string
}

interface ClientConnection {
  client: Client
  transport: ConnectionTransport
}

interface CloseResult {
  closed: boolean
  warning?: string
}

interface OutputValidator {
  validate: ValidateFunction
}

interface CatalogPage<T> {
  items: T[]
  nextCursor?: string
}

class ManagedStdioTransport extends StdioClientTransport {
  private closeRun: Promise<void> | undefined

  override close(): Promise<void> {
    this.closeRun ??= super.close()
    return this.closeRun
  }
}

class ManagedHttpTransport extends StreamableHTTPClientTransport {
  private closeRun: Promise<void> | undefined
  private readonly closePermission: Promise<void>
  private release: (() => void) | undefined

  constructor(...args: ConstructorParameters<typeof StreamableHTTPClientTransport>) {
    super(...args)
    this.closePermission = new Promise((resolve) => {
      this.release = resolve
    })
  }

  override close(): Promise<void> {
    this.closeRun ??= this.closePermission.then(() => super.close())
    return this.closeRun
  }

  releaseClose(): void {
    this.release?.()
    this.release = undefined
  }
}

class ManagedSseTransport extends SSEClientTransport {
  private closeRun: Promise<void> | undefined

  override close(): Promise<void> {
    this.closeRun ??= super.close()
    return this.closeRun
  }
}

function hash(value: string): string {
  let result = 2_166_136_261
  for (let index = 0; index < value.length; index++) {
    result = Math.imul(result ^ value.charCodeAt(index), 16_777_619)
  }
  return (result >>> 0).toString(36)
}

function nativeToolName(server: string, tool: string): string {
  const normalized = tool.replace(/[^A-Za-z0-9_-]/g, "_") || "tool"
  const base = `mcp__${server}__${normalized}`
  if (normalized === tool && base.length <= 64) return base
  const suffix = hash(`${server}\0${tool}`)
  return `${base.slice(0, 63 - suffix.length)}_${suffix}`
}

function progressText(progress: number, total: number | undefined, message: string | undefined): string {
  if (message) return message
  if (total !== undefined) return `MCP progress ${progress}/${total}`
  return `MCP progress ${progress}`
}

async function withinTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  label: string,
  signal?: AbortSignal,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let cancel: (() => void) | undefined
  const cancellation = signal
    ? new Promise<T>((_resolve, reject) => {
        cancel = () => reject(new Error(`${label} was cancelled`, { cause: signal.reason }))
        if (signal.aborted) cancel()
        else signal.addEventListener("abort", cancel, { once: true })
      })
    : undefined
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
      }),
      ...(cancellation ? [cancellation] : []),
    ])
  } finally {
    if (timer) clearTimeout(timer)
    if (signal && cancel) signal.removeEventListener("abort", cancel)
  }
}

async function withLinkedSignal<T>(parent: AbortSignal, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  const abort = () => controller.abort(parent.reason)
  if (parent.aborted) abort()
  else parent.addEventListener("abort", abort, { once: true })
  try {
    return await run(controller.signal)
  } finally {
    parent.removeEventListener("abort", abort)
  }
}

async function withDeadlineSignal<T>(
  timeoutMs: number,
  label: string,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
  try {
    return await run(controller.signal)
  } finally {
    clearTimeout(timer)
  }
}

function outputValidator(tool: McpTool): OutputValidator | undefined {
  if (!tool.outputSchema) return undefined
  if (tool.outputSchema.$async === true) {
    throw new Error(`MCP tool ${tool.name} uses an unsupported asynchronous output schema`)
  }
  const dialect = tool.outputSchema.$schema
  const normalized = typeof dialect === "string" ? dialect.replace(/#$/, "") : undefined
  if (normalized?.endsWith("json-schema.org/draft-07/schema")) {
    const ajv = new Ajv({ allErrors: true, strict: false })
    addFormats(ajv)
    return { validate: ajv.compile(tool.outputSchema) }
  }
  if (normalized?.endsWith("json-schema.org/draft/2019-09/schema")) {
    const ajv2019 = new Ajv2019({ allErrors: true, strict: false })
    addFormats(ajv2019)
    return { validate: ajv2019.compile(tool.outputSchema) }
  }
  if (normalized !== undefined && !normalized.endsWith("json-schema.org/draft/2020-12/schema")) {
    throw new Error(`MCP tool ${tool.name} uses unsupported output schema dialect ${normalized}`)
  }
  const ajv2020 = new Ajv2020({ allErrors: true, strict: false })
  addFormats(ajv2020)
  return { validate: ajv2020.compile(tool.outputSchema) }
}

function validateToolOutput(
  tool: McpTool,
  result: Awaited<ReturnType<Client["callTool"]>>,
  validator: OutputValidator | undefined,
): void {
  if (!validator) return
  if ("toolResult" in result) {
    throw new Error(`MCP tool ${tool.name} has an output schema but returned a legacy tool result`)
  }
  if (result.structuredContent === undefined && !result.isError) {
    throw new Error(`MCP tool ${tool.name} has an output schema but returned no structured content`)
  }
  if (result.structuredContent === undefined) return
  if (validator.validate(result.structuredContent)) return
  const detail =
    validator.validate.errors
      ?.map((error) => `${error.instancePath || "/"} ${error.message ?? error.keyword}`)
      .join("; ") ?? "unknown schema error"
  throw new Error(`MCP tool ${tool.name} returned invalid structured content: ${detail}`)
}

async function closeFailedClient(client: Client, error: unknown): Promise<string> {
  const reason = describeError(error)
  const cleanup = await closeClient(client)
  return cleanup.warning ? `${reason}; cleanup failed: ${cleanup.warning}` : reason
}

async function closeFailedHttpClient(client: Client, transport: ManagedHttpTransport, error: unknown): Promise<string> {
  const reason = describeError(error)
  const failures: string[] = []
  const termination = await terminateHttpSession(transport)
  if (termination) failures.push(termination)
  transport.releaseClose()
  const local = await closeLocalClient(client)
  if (local.warning) failures.push(local.warning)
  return failures.length > 0 ? `${reason}; cleanup failed: ${failures.join("; ")}` : reason
}

async function terminateHttpSession(transport: StreamableHTTPClientTransport): Promise<string | undefined> {
  try {
    await withinTimeout(transport.terminateSession(), 1_000, "MCP session termination")
    return undefined
  } catch (error) {
    return `session termination: ${describeError(error)}`
  }
}

async function closeClient(client: Client): Promise<CloseResult> {
  const failures: string[] = []
  if (client.transport instanceof StreamableHTTPClientTransport) {
    const termination = await terminateHttpSession(client.transport)
    if (termination) failures.push(termination)
  }
  const local = await closeLocalClient(client)
  if (local.warning) failures.push(local.warning)
  return {
    closed: local.closed,
    ...(failures.length > 0 ? { warning: failures.join("; ") } : {}),
  }
}

async function closeLocalClient(client: Client): Promise<CloseResult> {
  const failures: string[] = []
  let closed = true
  try {
    await withinTimeout(client.close(), 5_000, "MCP connection close")
  } catch (error) {
    closed = false
    failures.push(`connection close: ${describeError(error)}`)
  }
  return {
    closed,
    ...(failures.length > 0 ? { warning: failures.join("; ") } : {}),
  }
}

function closeWarnings(...results: CloseResult[]): string | undefined {
  const warnings = results.flatMap((result) => (result.warning ? [result.warning] : []))
  return warnings.length > 0 ? warnings.join("; ") : undefined
}

export class McpManager {
  private readonly entries = new Map<string, ServerEntry>()
  private closing = false

  constructor(
    configs: McpServerConfig[],
    private readonly tools: McpToolRegistry,
  ) {
    for (const config of configs) {
      this.entries.set(config.id, {
        config,
        state: config.enabled ? "idle" : "disabled",
        generation: 0,
        tools: [],
        resources: [],
        resourceTemplates: [],
        prompts: [],
        registeredTools: [],
        toolRevision: 0,
        resourceRevision: 0,
        promptRevision: 0,
        skippedTaskTools: [],
        skippedOutputTools: [],
        toolValidators: new Map(),
      })
    }
  }

  async connectAll(signal?: AbortSignal): Promise<void> {
    const connecting = Promise.all(
      [...this.entries.values()].filter((entry) => entry.config.enabled).map((entry) => this.connect(entry)),
    )
    if (!signal) {
      await connecting
      return
    }
    if (signal.aborted) {
      await this.close()
      return
    }
    let abort: (() => void) | undefined
    const closing = new Promise<void>((resolve, reject) => {
      abort = () => void this.close().then(resolve, reject)
      signal.addEventListener("abort", abort, { once: true })
    })
    try {
      await Promise.race([connecting.then(() => undefined), closing])
    } finally {
      if (abort) signal.removeEventListener("abort", abort)
    }
  }

  async reconnect(server?: string): Promise<void> {
    if (this.closing) throw new Error("MCP manager is shutting down")
    if (server) {
      const entry = this.entries.get(server)
      if (!entry) throw new Error(`unknown MCP server: ${server}`)
      if (!entry.config.enabled) throw new Error(`MCP server is disabled: ${server}`)
      await this.connect(entry)
      return
    }
    await this.connectAll()
  }

  async close(): Promise<void> {
    this.closing = true
    const failures = (
      await Promise.all(
        [...this.entries.values()].map(async (entry) => {
          entry.generation += 1
          entry.connectAbort?.abort()
          const connecting = entry.connectingClient
          const connectingClose = connecting ? await closeLocalClient(connecting) : { closed: true }
          const activeClose = await this.disconnect(entry)
          await entry.pendingConnect
          const settledClose = await this.disconnect(entry)
          this.resetCatalog(entry)
          entry.state = entry.config.enabled ? "idle" : "disabled"
          const warning = closeWarnings(connectingClose, activeClose, settledClose)
          return warning ? `${entry.config.id}: ${warning}` : undefined
        }),
      )
    ).filter((failure) => failure !== undefined)
    if (failures.length > 0) throw new Error(failures.join("; "))
  }

  hasResources(): boolean {
    return [...this.entries.values()].some(
      (entry) => entry.state === "connected" && entry.client?.getServerCapabilities()?.resources !== undefined,
    )
  }

  hasPrompts(): boolean {
    return [...this.entries.values()].some(
      (entry) => entry.state === "connected" && entry.client?.getServerCapabilities()?.prompts !== undefined,
    )
  }

  statusLines(): string[] {
    if (this.entries.size === 0) return ["No MCP servers configured."]
    return [...this.entries.values()].map((entry) => {
      if (entry.state === "connected") {
        const counts = [
          `${entry.tools.length} tools`,
          `${entry.resources.length} resources`,
          `${entry.resourceTemplates.length} templates`,
          `${entry.prompts.length} prompts`,
        ].join(" · ")
        const warnings = [
          ...(entry.skippedTaskTools.length > 0 ? [`${entry.skippedTaskTools.length} task-based tools skipped`] : []),
          ...(entry.skippedOutputTools.length > 0
            ? [`output schemas skipped: ${entry.skippedOutputTools.join("; ")}`]
            : []),
          ...(entry.error ? [entry.error] : []),
        ]
        return `${entry.config.id} · connected (${entry.connectionTransport}) · ${counts}${warnings.length > 0 ? ` · warning: ${warnings.join("; ")}` : ""}`
      }
      if (entry.state === "failed") return `${entry.config.id} · failed · ${entry.error ?? "unknown error"}`
      return `${entry.config.id} · ${entry.state}`
    })
  }

  prompt(): string {
    const sections = [...this.entries.values()].flatMap((entry) => {
      if (entry.state !== "connected" || !entry.instructions) return []
      return [`MCP server ${entry.config.id} instructions:\n${entry.instructions}`]
    })
    return sections.join("\n\n")
  }

  resourceCatalog(server?: string): string {
    const entries = this.connectedEntries(server, "resources")
    return formatJson(
      entries.map((entry) => ({
        server: entry.config.id,
        resources: entry.resources,
        templates: entry.resourceTemplates,
      })),
    )
  }

  promptCatalog(server?: string): string {
    const entries = this.connectedEntries(server, "prompts")
    return formatJson(entries.map((entry) => ({ server: entry.config.id, prompts: entry.prompts })))
  }

  async readResource(server: string, uri: string, signal: AbortSignal): Promise<string> {
    const entry = this.connectedEntry(server, "resources")
    const result = await withLinkedSignal(signal, (requestSignal) =>
      entry.client.readResource({ uri }, { signal: requestSignal, timeout: entry.config.timeoutMs }),
    )
    return result.contents.map(formatResourceContent).join("\n\n") || "(empty MCP resource)"
  }

  async getPrompt(
    server: string,
    name: string,
    args: Record<string, string> | undefined,
    signal: AbortSignal,
  ): Promise<string> {
    const entry = this.connectedEntry(server, "prompts")
    const result = await withLinkedSignal(signal, (requestSignal) =>
      entry.client.getPrompt(
        { name, ...(args ? { arguments: args } : {}) },
        { signal: requestSignal, timeout: entry.config.timeoutMs },
      ),
    )
    return formatPromptResult(result)
  }

  private async connect(entry: ServerEntry): Promise<void> {
    const previous = entry.pendingConnect ?? Promise.resolve()
    const current = previous.then(() => this.connectNow(entry))
    entry.pendingConnect = current
    await current.finally(() => {
      if (entry.pendingConnect === current) entry.pendingConnect = undefined
    })
  }

  private async connectNow(entry: ServerEntry): Promise<void> {
    if (this.closing) return
    entry.generation += 1
    const generation = entry.generation
    const cleanup = await this.disconnect(entry)
    this.resetCatalog(entry)
    entry.state = "connecting"
    entry.error = cleanup.warning

    if (!cleanup.closed) {
      entry.state = "failed"
      return
    }

    const abort = new AbortController()
    entry.connectAbort = abort
    let connection: ClientConnection | undefined
    try {
      connection =
        entry.config.transport === "stdio"
          ? await this.connectStdio(entry, generation, abort.signal)
          : await this.connectHttp(entry, generation, abort.signal)
      if (entry.generation !== generation) {
        const reason = await closeFailedClient(connection.client, "connection was superseded")
        throw new Error(reason)
      }
      entry.client = connection.client
      entry.connectionTransport = connection.transport
      await this.discover(entry)
      if (entry.generation !== generation || entry.client !== connection.client) {
        throw new Error(`MCP server disconnected during discovery: ${entry.config.id}`)
      }
      entry.instructions = connection.client.getInstructions()
      entry.state = "connected"
      entry.error = cleanup.warning
      this.registerServerTools(entry)
    } catch (error) {
      if (connection) {
        entry.client = undefined
        entry.error = await closeFailedClient(connection.client, error)
      } else {
        entry.error = describeError(error)
      }
      this.unregisterServerTools(entry)
      this.resetCatalog(entry)
      entry.state = "failed"
    } finally {
      if (entry.connectAbort === abort) entry.connectAbort = undefined
    }
  }

  private async connectStdio(entry: ServerEntry, generation: number, signal: AbortSignal): Promise<ClientConnection> {
    if (entry.config.transport !== "stdio") throw new Error("MCP transport configuration changed unexpectedly")
    const client = this.createClient(entry, generation)
    const transport = new ManagedStdioTransport({
      command: entry.config.command,
      args: entry.config.args,
      env: { ...getDefaultEnvironment(), ...entry.config.env },
      stderr: "ignore",
      cwd: entry.config.cwd,
    })
    entry.connectingClient = client
    try {
      await withinTimeout(
        client.connect(transport, {
          timeout: entry.config.timeoutMs,
          maxTotalTimeout: entry.config.timeoutMs,
        }),
        entry.config.timeoutMs,
        `MCP connection to ${entry.config.id}`,
        signal,
      )
      return { client, transport: "stdio" }
    } catch (error) {
      throw new Error(await closeFailedClient(client, error), { cause: error })
    } finally {
      if (entry.connectingClient === client) entry.connectingClient = undefined
    }
  }

  private async connectHttp(entry: ServerEntry, generation: number, signal: AbortSignal): Promise<ClientConnection> {
    if (entry.config.transport !== "http") throw new Error("MCP transport configuration changed unexpectedly")
    const url = new URL(entry.config.url)
    const requestInit = { headers: entry.config.headers }
    const httpClient = this.createClient(entry, generation)
    const httpTransport = new ManagedHttpTransport(url, { requestInit })
    entry.connectingClient = httpClient
    try {
      await withinTimeout(
        httpClient.connect(httpTransport, {
          timeout: entry.config.timeoutMs,
          maxTotalTimeout: entry.config.timeoutMs,
        }),
        entry.config.timeoutMs,
        `MCP connection to ${entry.config.id}`,
        signal,
      )
      httpTransport.releaseClose()
      return { client: httpClient, transport: "http" }
    } catch (httpError) {
      const fallback =
        httpTransport.protocolVersion === undefined &&
        httpError instanceof StreamableHTTPError &&
        httpError.code !== undefined &&
        httpError.code >= 400 &&
        httpError.code < 500
      const httpReason = await closeFailedHttpClient(httpClient, httpTransport, httpError)
      if (!fallback) {
        throw new Error(`streamable HTTP failed: ${httpReason}`, { cause: httpError })
      }
      const sseClient = this.createClient(entry, generation)
      entry.connectingClient = sseClient
      try {
        await withinTimeout(
          sseClient.connect(new ManagedSseTransport(url, { requestInit }), {
            timeout: entry.config.timeoutMs,
            maxTotalTimeout: entry.config.timeoutMs,
          }),
          entry.config.timeoutMs,
          `legacy MCP connection to ${entry.config.id}`,
          signal,
        )
        return { client: sseClient, transport: "sse" }
      } catch (sseError) {
        const sseReason = await closeFailedClient(sseClient, sseError)
        throw new Error(`streamable HTTP failed: ${httpReason}; SSE fallback failed: ${sseReason}`, {
          cause: sseError,
        })
      } finally {
        if (entry.connectingClient === sseClient) entry.connectingClient = undefined
      }
    } finally {
      if (entry.connectingClient === httpClient) entry.connectingClient = undefined
    }
  }

  private createClient(entry: ServerEntry, generation: number): Client {
    const client = new Client(
      { name: `${appInfo.name}-${entry.config.id}`, version: appInfo.version },
      {
        listChanged: {
          tools: {
            autoRefresh: false,
            onChanged: (error) => this.toolsChanged(entry, generation, error),
          },
          prompts: {
            autoRefresh: false,
            onChanged: (error) => this.promptsChanged(entry, generation, error),
          },
          resources: {
            autoRefresh: false,
            onChanged: (error) => this.resourcesChanged(entry, generation, error),
          },
        },
      },
    )
    client.onerror = (error) => {
      if (entry.generation === generation && entry.client === client) entry.error = describeError(error)
    }
    client.onclose = () => {
      if (entry.generation !== generation || entry.client !== client) return
      entry.client = undefined
      entry.state = "failed"
      entry.error = entry.error ?? "connection closed"
      this.unregisterServerTools(entry)
      this.resetCatalog(entry)
    }
    return client
  }

  private async discover(entry: ServerEntry): Promise<void> {
    const client = entry.client
    if (!client) throw new Error(`MCP server disconnected during discovery: ${entry.config.id}`)
    const capabilities = client.getServerCapabilities()
    await withDeadlineSignal(entry.config.timeoutMs, `MCP discovery for ${entry.config.id}`, async (deadline) => {
      while (true) {
        const toolRevision = entry.toolRevision
        const resourceRevision = entry.resourceRevision
        const promptRevision = entry.promptRevision
        const [tools, resources, resourceTemplates, prompts] = await Promise.all([
          capabilities?.tools ? this.listTools(client, entry.config.timeoutMs, deadline) : [],
          capabilities?.resources ? this.listResources(client, entry.config.timeoutMs, deadline) : [],
          capabilities?.resources ? this.listResourceTemplates(client, entry.config.timeoutMs, deadline) : [],
          capabilities?.prompts ? this.listPrompts(client, entry.config.timeoutMs, deadline) : [],
        ])
        if (
          toolRevision !== entry.toolRevision ||
          resourceRevision !== entry.resourceRevision ||
          promptRevision !== entry.promptRevision
        ) {
          continue
        }
        this.setTools(entry, tools)
        entry.resources = resources
        entry.resourceTemplates = resourceTemplates
        entry.prompts = prompts
        return
      }
    })
  }

  private async listTools(client: Client, timeout: number, deadline?: AbortSignal): Promise<McpTool[]> {
    return this.paginate(
      timeout,
      "MCP tools listing",
      async (cursor, signal) => {
        const result = await client.request(
          {
            method: "tools/list",
            ...(cursor === undefined ? {} : { params: { cursor } }),
          },
          ListToolsResultSchema,
          { signal, timeout },
        )
        return {
          items: result.tools,
          ...(result.nextCursor === undefined ? {} : { nextCursor: result.nextCursor }),
        }
      },
      deadline,
    )
  }

  private async listResources(client: Client, timeout: number, deadline?: AbortSignal): Promise<Resource[]> {
    return this.paginate(
      timeout,
      "MCP resources listing",
      async (cursor, signal) => {
        const result = await client.listResources(cursor === undefined ? undefined : { cursor }, { signal, timeout })
        return {
          items: result.resources,
          ...(result.nextCursor === undefined ? {} : { nextCursor: result.nextCursor }),
        }
      },
      deadline,
    )
  }

  private async listResourceTemplates(
    client: Client,
    timeout: number,
    deadline?: AbortSignal,
  ): Promise<ResourceTemplate[]> {
    return this.paginate(
      timeout,
      "MCP resource templates listing",
      async (cursor, signal) => {
        const result = await client.listResourceTemplates(cursor === undefined ? undefined : { cursor }, {
          signal,
          timeout,
        })
        return {
          items: result.resourceTemplates,
          ...(result.nextCursor === undefined ? {} : { nextCursor: result.nextCursor }),
        }
      },
      deadline,
    )
  }

  private async listPrompts(client: Client, timeout: number, deadline?: AbortSignal): Promise<Prompt[]> {
    return this.paginate(
      timeout,
      "MCP prompts listing",
      async (cursor, signal) => {
        const result = await client.listPrompts(cursor === undefined ? undefined : { cursor }, { signal, timeout })
        return {
          items: result.prompts,
          ...(result.nextCursor === undefined ? {} : { nextCursor: result.nextCursor }),
        }
      },
      deadline,
    )
  }

  private async paginate<T>(
    timeout: number,
    label: string,
    load: (cursor: string | undefined, signal: AbortSignal) => Promise<CatalogPage<T>>,
    deadline?: AbortSignal,
  ): Promise<T[]> {
    const collect = async (signal: AbortSignal): Promise<T[]> => {
      const items: T[] = []
      const seen = new Set<string>()
      let cursor: string | undefined
      while (true) {
        const page = await withLinkedSignal(signal, (requestSignal) => load(cursor, requestSignal))
        items.push(...page.items)
        if (page.nextCursor === undefined) return items
        if (seen.has(page.nextCursor)) throw new Error(`${label} repeated a cursor`)
        seen.add(page.nextCursor)
        cursor = page.nextCursor
      }
    }
    if (deadline) return collect(deadline)
    return withDeadlineSignal(timeout, label, collect)
  }

  private registerServerTools(entry: ServerEntry): void {
    this.unregisterServerTools(entry)
    const tools = entry.tools.map((tool) => this.tool(entry, tool))
    try {
      for (const tool of tools) this.tools.register(tool)
      entry.registeredTools = tools
    } catch (error) {
      for (const tool of tools) this.tools.unregister(tool)
      throw error
    }
  }

  private unregisterServerTools(entry: ServerEntry): void {
    for (const tool of entry.registeredTools) this.tools.unregister(tool)
    entry.registeredTools = []
  }

  private tool(entry: ServerEntry, remote: McpTool): Tool {
    const name = nativeToolName(entry.config.id, remote.name)
    const validator = entry.toolValidators.get(remote)
    return {
      name,
      description: `MCP tool ${remote.name} from server ${entry.config.id}. ${remote.description ?? "No server description."}`,
      parameters: remote.inputSchema,
      title: () => remote.title ?? remote.annotations?.title ?? `${entry.config.id}: ${remote.name}`,
      undo: () => ({ type: "invalidate" }),
      permission: () => ({ subject: `${entry.config.id}/${remote.name}`, suggestion: name }),
      execute: async (args, ctx) => {
        const current = this.connectedEntry(entry.config.id, "tools")
        if (!current.tools.includes(remote)) {
          throw new Error(`MCP tool is no longer available: ${entry.config.id}/${remote.name}`)
        }
        const result = await withLinkedSignal(ctx.signal, (signal) =>
          current.client.callTool({ name: remote.name, arguments: args }, CompatibilityCallToolResultSchema, {
            signal,
            timeout: current.config.timeoutMs,
            onprogress: (progress) => ctx.update(progressText(progress.progress, progress.total, progress.message)),
          }),
        )
        validateToolOutput(remote, result, validator)
        return { output: formatToolResult(result) }
      },
    }
  }

  private toolsChanged(entry: ServerEntry, generation: number, error: Error | null): void {
    if (entry.generation !== generation) return
    entry.toolRevision += 1
    if (error) {
      entry.error = describeError(error)
      return
    }
    if (entry.state !== "connected") return
    const client = entry.client
    if (!client) return
    const revision = entry.toolRevision
    void this.listTools(client, entry.config.timeoutMs).then(
      (tools) => {
        if (entry.generation !== generation || entry.client !== client || entry.toolRevision !== revision) return
        try {
          this.setTools(entry, tools)
          this.registerServerTools(entry)
          entry.error = undefined
        } catch (syncError) {
          this.unregisterServerTools(entry)
          entry.tools = []
          entry.skippedTaskTools = []
          entry.skippedOutputTools = []
          entry.toolValidators.clear()
          entry.error = describeError(syncError)
        }
      },
      (refreshError) => {
        if (entry.generation === generation && entry.client === client) entry.error = describeError(refreshError)
      },
    )
  }

  private promptsChanged(entry: ServerEntry, generation: number, error: Error | null): void {
    if (entry.generation !== generation) return
    entry.promptRevision += 1
    if (error) {
      entry.error = describeError(error)
      return
    }
    if (entry.state !== "connected") return
    const client = entry.client
    if (!client) return
    const revision = entry.promptRevision
    void this.listPrompts(client, entry.config.timeoutMs).then(
      (prompts) => {
        if (entry.generation !== generation || entry.client !== client || entry.promptRevision !== revision) return
        entry.prompts = prompts
        entry.error = undefined
      },
      (refreshError) => {
        if (entry.generation === generation && entry.client === client) entry.error = describeError(refreshError)
      },
    )
  }

  private resourcesChanged(entry: ServerEntry, generation: number, error: Error | null): void {
    if (entry.generation !== generation) return
    entry.resourceRevision += 1
    if (error) {
      entry.error = describeError(error)
      return
    }
    if (entry.state !== "connected") return
    const client = entry.client
    if (!client) return
    const revision = entry.resourceRevision
    void Promise.all([
      this.listResources(client, entry.config.timeoutMs),
      this.listResourceTemplates(client, entry.config.timeoutMs),
    ]).then(
      ([resources, templates]) => {
        if (entry.generation !== generation || entry.client !== client || entry.resourceRevision !== revision) return
        entry.resources = resources
        entry.resourceTemplates = templates
        entry.error = undefined
      },
      (refreshError) => {
        if (entry.generation === generation && entry.client === client) entry.error = describeError(refreshError)
      },
    )
  }

  private connectedEntries(server: string | undefined, capability: "resources" | "prompts"): ServerEntry[] {
    if (server) return [this.connectedEntry(server, capability)]
    return [...this.entries.values()].filter(
      (entry) => entry.state === "connected" && entry.client?.getServerCapabilities()?.[capability] !== undefined,
    )
  }

  private validateTools(entry: ServerEntry, tools: McpTool[]): void {
    const remoteNames = new Set<string>()
    const nativeNames = new Set<string>()
    for (const tool of tools) {
      if (remoteNames.has(tool.name)) throw new Error(`MCP server returned duplicate tool: ${tool.name}`)
      remoteNames.add(tool.name)
      const nativeName = nativeToolName(entry.config.id, tool.name)
      if (nativeNames.has(nativeName)) throw new Error(`MCP tool names collide after normalization: ${nativeName}`)
      nativeNames.add(nativeName)
    }
  }

  private setTools(entry: ServerEntry, tools: McpTool[]): void {
    this.validateTools(entry, tools)
    entry.skippedTaskTools = tools.filter((tool) => tool.execution?.taskSupport === "required").map((tool) => tool.name)
    entry.skippedOutputTools = []
    entry.toolValidators = new Map()
    entry.tools = tools.filter((tool) => {
      if (tool.execution?.taskSupport === "required") return false
      try {
        entry.toolValidators.set(tool, outputValidator(tool))
        return true
      } catch (error) {
        entry.skippedOutputTools.push(`${tool.name}: ${describeError(error)}`)
        return false
      }
    })
  }

  private connectedEntry(
    server: string,
    capability: "tools" | "resources" | "prompts",
  ): ServerEntry & { client: Client } {
    const entry = this.entries.get(server)
    if (!entry) throw new Error(`unknown MCP server: ${server}`)
    if (entry.state !== "connected" || !entry.client) throw new Error(`MCP server is not connected: ${server}`)
    if (entry.client.getServerCapabilities()?.[capability] === undefined) {
      throw new Error(`MCP server does not provide ${capability}: ${server}`)
    }
    return { ...entry, client: entry.client }
  }

  private async disconnect(entry: ServerEntry): Promise<CloseResult> {
    this.unregisterServerTools(entry)
    const client = entry.client
    entry.client = undefined
    entry.connectionTransport = undefined
    if (!client) return { closed: true }
    return closeClient(client)
  }

  private resetCatalog(entry: ServerEntry): void {
    entry.tools = []
    entry.resources = []
    entry.resourceTemplates = []
    entry.prompts = []
    entry.skippedTaskTools = []
    entry.skippedOutputTools = []
    entry.toolValidators.clear()
    entry.instructions = undefined
  }
}
