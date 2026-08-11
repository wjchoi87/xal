import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { basename, normalize, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { appInfo } from "../../app-info"
import { describeError } from "../../lib/error"
import { isJsonObject, isRecord, type JsonObject, type JsonValue } from "../../lib/json"
import { killProcessTree } from "../../lib/process"
import { JsonRpcConnection, JsonRpcRequestError } from "./protocol"

const STDERR_LIMIT = 16 * 1024
const STDERR_DISPLAY_LIMIT = 500
const CLOSE_TIMEOUT_MS = 2_000

export type LspClientStatus = "starting" | "ready" | "failed" | "closing" | "closed"

export interface LspClientOptions {
  id: string
  root: string
  command: string
  args?: string[]
  env?: Record<string, string>
  initializationOptions?: JsonObject
  settings?: JsonObject
  timeoutMs?: number
  signal?: AbortSignal
}

export interface SyncedDocument {
  uri: string
  version: number
  changed: boolean
}

interface OpenDocument {
  uri: string
  version: number
  languageId: string
  text: string
  opened: boolean
}

interface PublishedDiagnostics {
  version?: number
  items: JsonObject[]
}

interface DiagnosticWaiter {
  path: string
  version: number
  resolve(value: boolean): void
  reject(error: unknown): void
  timer: ReturnType<typeof setTimeout>
  signal?: AbortSignal
  abort?: () => void
}

interface TextDocumentSync {
  openClose: boolean
  change: number
  save: boolean
  includeText: boolean
}

function normalizedPath(path: string): string {
  return normalize(resolve(path))
}

function endPosition(text: string): JsonObject {
  const lines = text.split(/\r\n|\r|\n/)
  return { line: lines.length - 1, character: lines.at(-1)?.length ?? 0 }
}

function cancellation(signal: AbortSignal): Error {
  const error = new Error("LSP operation was cancelled", { cause: signal.reason })
  error.name = "AbortError"
  return error
}

function textDocumentSync(capabilities: JsonObject): TextDocumentSync {
  const value = capabilities.textDocumentSync
  if (typeof value === "number" && Number.isInteger(value)) {
    return { openClose: value !== 0, change: value, save: false, includeText: false }
  }
  if (!isRecord(value)) return { openClose: false, change: 0, save: false, includeText: false }
  const change = typeof value.change === "number" && Number.isInteger(value.change) ? value.change : 0
  const save = value.save
  return {
    openClose: value.openClose === true,
    change,
    save: save === true || isRecord(save),
    includeText: isRecord(save) && save.includeText === true,
  }
}

function waitForExit(process: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (process.pid === undefined) return Promise.resolve(true)
  if (process.exitCode !== null || process.signalCode !== null) return Promise.resolve(true)
  return new Promise((resolve) => {
    const finish = (exited: boolean): void => {
      clearTimeout(timer)
      process.off("exit", onExit)
      resolve(exited)
    }
    const onExit = (): void => finish(true)
    process.once("exit", onExit)
    const timer = setTimeout(() => finish(false), timeoutMs)
    timer.unref()
  })
}

function settlesBeforeAbort(run: Promise<unknown>, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false)
  return new Promise((resolve) => {
    let settled = false
    const finish = (completed: boolean): void => {
      if (settled) return
      settled = true
      signal.removeEventListener("abort", onAbort)
      resolve(completed)
    }
    const onAbort = (): void => finish(false)
    signal.addEventListener("abort", onAbort, { once: true })
    if (signal.aborted) onAbort()
    void run.then(
      () => finish(true),
      () => finish(true),
    )
  })
}

function configurationValue(settings: JsonObject | undefined, section: unknown): JsonValue {
  if (typeof section !== "string" || section.length === 0) return settings ? structuredClone(settings) : null
  let current: unknown = settings
  for (const key of section.split(".")) {
    if (!isRecord(current) || !Object.hasOwn(current, key)) return null
    current = current[key]
  }
  return isJsonObject(current) ||
    Array.isArray(current) ||
    current === null ||
    typeof current === "string" ||
    typeof current === "boolean" ||
    (typeof current === "number" && Number.isFinite(current))
    ? structuredClone(current)
    : null
}

export class LspClient {
  readonly id: string
  readonly root: string
  private statusValue: LspClientStatus = "starting"
  private failureValue: unknown
  private stderrBytes = Buffer.alloc(0)
  private capabilitiesValue: JsonObject = {}
  private sync: TextDocumentSync = { openClose: false, change: 0, save: false, includeText: false }
  private readonly documents = new Map<string, OpenDocument>()
  private readonly publishedDiagnostics = new Map<string, PublishedDiagnostics>()
  private readonly diagnosticWaiters = new Set<DiagnosticWaiter>()
  private syncRun = Promise.resolve()
  private closeRun: Promise<void> | undefined
  private readonly process: ChildProcessWithoutNullStreams
  private readonly connection: JsonRpcConnection
  private readonly settings?: JsonObject
  private readonly timeoutMs: number
  private readonly spawned: Promise<void>

  private constructor(options: LspClientOptions) {
    this.id = options.id
    this.root = normalizedPath(options.root)
    this.settings = options.settings ? structuredClone(options.settings) : undefined
    this.timeoutMs = options.timeoutMs ?? 30_000
    this.process = spawn(options.command, options.args ?? [], {
      cwd: this.root,
      env: { ...process.env, ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    })
    this.spawned = new Promise((resolve, reject) => {
      const onSpawn = (): void => {
        this.process.off("error", onError)
        resolve()
      }
      const onError = (error: unknown): void => {
        this.process.off("spawn", onSpawn)
        reject(error)
      }
      this.process.once("spawn", onSpawn)
      this.process.once("error", onError)
    })
    this.process.stderr.on("data", (chunk: unknown) => this.captureStderr(chunk))
    this.process.stderr.on("error", (error) =>
      this.fail(new Error(`LSP server ${this.id} stderr failed`, { cause: error })),
    )
    this.process.on("error", (error) => this.fail(new Error(`LSP server ${this.id} process failed`, { cause: error })))
    this.process.on("exit", (code, signal) => {
      if (this.statusValue === "closing" || this.statusValue === "closed") return
      const detail = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`
      this.fail(new Error(`LSP server ${this.id} exited with ${detail}`))
    })
    this.connection = new JsonRpcConnection({
      readable: this.process.stdout,
      writable: this.process.stdin,
      timeoutMs: this.timeoutMs,
      onNotification: (method, params) => this.onNotification(method, params),
      onRequest: (method, params) => this.onRequest(method, params),
      onFailure: (error) => this.fail(error),
    })
    this.connection.listen()
  }

  static async start(options: LspClientOptions): Promise<LspClient> {
    if (options.signal?.aborted) throw cancellation(options.signal)
    const client = new LspClient(options)
    try {
      await client.waitUntilSpawned(options.signal)
      await client.initialize(options.initializationOptions, options.signal)
      if (options.signal?.aborted) throw cancellation(options.signal)
      if (client.statusValue !== "starting") {
        throw new Error(`LSP server ${options.id} became ${client.statusValue} during initialization`)
      }
      client.statusValue = "ready"
      return client
    } catch (error) {
      client.failureValue ??= error
      let cleanup: unknown
      try {
        await client.close()
      } catch (closeError) {
        cleanup = closeError
      }
      const cleanupSuffix = cleanup ? `; cleanup failed: ${describeError(cleanup)}` : ""
      const stderr = client.stderr.trim()
      const stderrSuffix = stderr ? `; stderr: ${stderr}` : ""
      throw new Error(
        `Failed to initialize LSP server ${options.id}: ${describeError(error)}${cleanupSuffix}${stderrSuffix}`,
        { cause: error },
      )
    }
  }

  get status(): LspClientStatus {
    return this.statusValue
  }

  get stderr(): string {
    const text = this.stderrBytes.toString("utf8").replace(/\s+/g, " ").trim()
    return text.length > STDERR_DISPLAY_LIMIT ? `…${text.slice(1 - STDERR_DISPLAY_LIMIT)}` : text
  }

  get failure(): unknown | undefined {
    return this.failureValue
  }

  get capabilities(): unknown {
    return structuredClone(this.capabilitiesValue)
  }

  request(method: string, params?: JsonValue, signal?: AbortSignal): Promise<JsonValue> {
    if (this.statusValue !== "ready") return Promise.reject(new Error(`LSP server ${this.id} is ${this.statusValue}`))
    return this.connection.request(method, params, signal)
  }

  syncDocument(path: string, languageId: string, signal?: AbortSignal): Promise<SyncedDocument> {
    const run = this.syncRun.then(() => this.runSyncDocument(path, languageId, signal))
    this.syncRun = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  diagnosticsFor(path: string): unknown[] {
    return (this.publishedDiagnostics.get(normalizedPath(path))?.items ?? []).map((item) => structuredClone(item))
  }

  waitForDiagnostics(path: string, version: number, timeoutMs = 5_000, signal?: AbortSignal): Promise<boolean> {
    const normalized = normalizedPath(path)
    const current = this.publishedDiagnostics.get(normalized)
    if (current && (current.version === undefined || current.version === version)) return Promise.resolve(true)
    if (this.statusValue !== "ready") return Promise.reject(new Error(`LSP server ${this.id} is ${this.statusValue}`))
    if (signal?.aborted) return Promise.reject(cancellation(signal))

    return new Promise<boolean>((resolve, reject) => {
      const timer = setTimeout(() => this.finishDiagnosticWaiter(waiter, false), timeoutMs)
      timer.unref()
      const waiter: DiagnosticWaiter = {
        path: normalized,
        version,
        resolve,
        reject,
        timer,
        ...(signal ? { signal } : {}),
      }
      this.diagnosticWaiters.add(waiter)
      if (signal) {
        waiter.abort = () => {
          this.removeDiagnosticWaiter(waiter)
          reject(cancellation(signal))
        }
        signal.addEventListener("abort", waiter.abort, { once: true })
        if (signal.aborted) waiter.abort()
      }
    })
  }

  close(): Promise<void> {
    this.closeRun ??= this.runClose()
    return this.closeRun
  }

  private async initialize(
    initializationOptions: JsonObject | undefined,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const result = await this.connection.request(
      "initialize",
      {
        processId: process.pid,
        clientInfo: { name: appInfo.name, version: appInfo.version },
        rootUri: pathToFileURL(this.root).href,
        workspaceFolders: [{ name: basename(this.root), uri: pathToFileURL(this.root).href }],
        ...(initializationOptions ? { initializationOptions } : {}),
        capabilities: {
          general: { positionEncodings: ["utf-16"] },
          window: { workDoneProgress: true },
          workspace: {
            applyEdit: false,
            configuration: true,
            workspaceFolders: true,
            symbol: { dynamicRegistration: false },
          },
          textDocument: {
            synchronization: {
              dynamicRegistration: false,
              willSave: false,
              willSaveWaitUntil: false,
              didSave: true,
            },
            hover: { dynamicRegistration: false, contentFormat: ["markdown", "plaintext"] },
            definition: { dynamicRegistration: false, linkSupport: true },
            references: { dynamicRegistration: false },
            documentSymbol: { dynamicRegistration: false, hierarchicalDocumentSymbolSupport: true },
            implementation: { dynamicRegistration: false, linkSupport: true },
            diagnostic: { dynamicRegistration: false, relatedDocumentSupport: false },
            publishDiagnostics: { relatedInformation: true, versionSupport: true },
            callHierarchy: { dynamicRegistration: false },
          },
        },
      },
      signal,
    )
    if (!isRecord(result) || !isJsonObject(result.capabilities)) {
      throw new Error(`LSP server ${this.id} returned invalid initialize capabilities`)
    }
    const encoding = result.capabilities.positionEncoding
    if (encoding !== undefined && encoding !== "utf-16") {
      throw new Error(`LSP server ${this.id} selected unsupported position encoding ${String(encoding)}`)
    }
    this.capabilitiesValue = structuredClone(result.capabilities)
    this.sync = textDocumentSync(this.capabilitiesValue)
    await this.connection.notify("initialized", {}, signal)
    if (this.settings) {
      await this.connection.notify("workspace/didChangeConfiguration", { settings: this.settings }, signal)
    }
  }

  private async runSyncDocument(
    path: string,
    languageId: string,
    signal: AbortSignal | undefined,
  ): Promise<SyncedDocument> {
    if (this.statusValue !== "ready") throw new Error(`LSP server ${this.id} is ${this.statusValue}`)
    if (signal?.aborted) throw cancellation(signal)
    const normalized = normalizedPath(path)
    const text = await Bun.file(normalized).text()
    if (text.includes("\u0000")) throw new Error(`Cannot synchronize binary file: ${normalized}`)
    if (signal?.aborted) throw cancellation(signal)
    if (this.statusValue !== "ready") throw new Error(`LSP server ${this.id} is ${this.statusValue}`)
    const uri = pathToFileURL(normalized).href
    const previous = this.documents.get(normalized)
    if (previous?.text === text && previous.languageId === languageId) {
      return { uri, version: previous.version, changed: false }
    }

    const version = (previous?.version ?? -1) + 1
    const document: OpenDocument = { uri, version, languageId, text, opened: this.sync.openClose }
    this.documents.set(normalized, document)
    this.publishedDiagnostics.delete(normalized)

    if (!previous || previous.languageId !== languageId) {
      if (previous?.opened) {
        await this.connection.notify("textDocument/didClose", { textDocument: { uri } }, signal)
      }
      if (document.opened) {
        await this.connection.notify(
          "textDocument/didOpen",
          {
            textDocument: { uri, languageId, version, text },
          },
          signal,
        )
      }
    } else if (document.opened) {
      if (this.sync.change === 0) {
        await this.connection.notify("textDocument/didClose", { textDocument: { uri } }, signal)
        await this.connection.notify(
          "textDocument/didOpen",
          {
            textDocument: { uri, languageId, version, text },
          },
          signal,
        )
      } else {
        await this.connection.notify(
          "textDocument/didChange",
          {
            textDocument: { uri, version },
            contentChanges:
              this.sync.change === 2
                ? [{ range: { start: { line: 0, character: 0 }, end: endPosition(previous.text) }, text }]
                : [{ text }],
          },
          signal,
        )
      }
    }

    if (document.opened && this.sync.save) {
      await this.connection.notify(
        "textDocument/didSave",
        {
          textDocument: { uri },
          ...(this.sync.includeText ? { text } : {}),
        },
        signal,
      )
    }
    return { uri, version, changed: true }
  }

  private onNotification(method: string, params: JsonValue | undefined): void {
    if (method !== "textDocument/publishDiagnostics") return
    if (!isRecord(params) || typeof params.uri !== "string" || !Array.isArray(params.diagnostics)) {
      throw new Error(`LSP server ${this.id} published malformed diagnostics`)
    }
    let path: string
    try {
      path = normalizedPath(fileURLToPath(params.uri))
    } catch (error) {
      throw new Error(`LSP server ${this.id} published diagnostics for an invalid file URI`, { cause: error })
    }
    const version = params.version
    if (version !== undefined && (typeof version !== "number" || !Number.isInteger(version))) {
      throw new Error(`LSP server ${this.id} published diagnostics with an invalid version`)
    }
    const items = params.diagnostics.flatMap((item) => (isJsonObject(item) ? [structuredClone(item)] : []))
    if (items.length !== params.diagnostics.length) {
      throw new Error(`LSP server ${this.id} published a malformed diagnostic`)
    }
    const document = this.documents.get(path)
    if (document && version !== undefined && version !== document.version) return
    this.publishedDiagnostics.set(path, { ...(version === undefined ? {} : { version }), items })
    for (const waiter of [...this.diagnosticWaiters]) {
      if (waiter.path !== path || (version !== undefined && waiter.version !== version)) continue
      this.finishDiagnosticWaiter(waiter, true)
    }
  }

  private onRequest(method: string, params: JsonValue | undefined): JsonValue {
    switch (method) {
      case "workspace/configuration": {
        if (!isRecord(params) || !Array.isArray(params.items)) return []
        return params.items.map((item) => configurationValue(this.settings, isRecord(item) ? item.section : undefined))
      }
      case "workspace/workspaceFolders":
        return [{ name: basename(this.root), uri: pathToFileURL(this.root).href }]
      case "window/workDoneProgress/create":
      case "client/registerCapability":
      case "client/unregisterCapability":
      case "workspace/diagnostic/refresh":
      case "workspace/semanticTokens/refresh":
      case "workspace/inlayHint/refresh":
      case "workspace/codeLens/refresh":
      case "window/showMessageRequest":
        return null
      case "workspace/applyEdit":
        return { applied: false, failureReason: "Tack's LSP client does not apply server edits" }
      default:
        throw new JsonRpcRequestError(-32601, `Method not found: ${method}`)
    }
  }

  private waitUntilSpawned(signal: AbortSignal | undefined): Promise<void> {
    if (!signal) return this.spawned
    return new Promise((resolve, reject) => {
      const abort = (): void => reject(cancellation(signal))
      signal.addEventListener("abort", abort, { once: true })
      if (signal.aborted) abort()
      void this.spawned.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort))
    })
  }

  private captureStderr(chunk: unknown): void {
    const bytes = Buffer.isBuffer(chunk)
      ? chunk
      : typeof chunk === "string"
        ? Buffer.from(chunk)
        : chunk instanceof Uint8Array
          ? Buffer.from(chunk)
          : undefined
    if (!bytes) return
    this.stderrBytes = Buffer.concat([this.stderrBytes, bytes]).subarray(-STDERR_LIMIT)
  }

  private finishDiagnosticWaiter(waiter: DiagnosticWaiter, value: boolean): void {
    this.removeDiagnosticWaiter(waiter)
    waiter.resolve(value)
  }

  private removeDiagnosticWaiter(waiter: DiagnosticWaiter): void {
    if (!this.diagnosticWaiters.delete(waiter)) return
    clearTimeout(waiter.timer)
    if (waiter.signal && waiter.abort) waiter.signal.removeEventListener("abort", waiter.abort)
  }

  private fail(error: unknown): void {
    if (this.statusValue === "closing" || this.statusValue === "closed" || this.statusValue === "failed") return
    this.statusValue = "failed"
    this.failureValue ??= error
    this.connection.close(error)
    for (const waiter of [...this.diagnosticWaiters]) {
      this.removeDiagnosticWaiter(waiter)
      waiter.reject(error)
    }
    killProcessTree(this.process)
  }

  private async runClose(): Promise<void> {
    if (this.statusValue === "closed") return
    const graceful = this.statusValue === "ready"
    this.statusValue = "closing"
    const failures: unknown[] = []
    const controller = new AbortController()
    const deadline = Date.now() + CLOSE_TIMEOUT_MS
    let deadlineExceeded = false
    const force = (): void => {
      if (deadlineExceeded) return
      deadlineExceeded = true
      const error = new Error(`LSP server ${this.id} close timed out after ${CLOSE_TIMEOUT_MS}ms`)
      controller.abort(error)
      this.connection.close(error)
      killProcessTree(this.process)
    }
    const closeTimer = setTimeout(force, CLOSE_TIMEOUT_MS)
    closeTimer.unref()

    await settlesBeforeAbort(this.syncRun, controller.signal)

    if (graceful && !controller.signal.aborted) {
      for (const document of this.documents.values()) {
        if (!document.opened) continue
        try {
          await this.connection.notify(
            "textDocument/didClose",
            { textDocument: { uri: document.uri } },
            controller.signal,
          )
        } catch (error) {
          failures.push(error)
          break
        }
      }

      if (!controller.signal.aborted) {
        try {
          await this.connection.request("shutdown", undefined, controller.signal)
          await this.connection.notify("exit", undefined, controller.signal)
        } catch (error) {
          failures.push(error)
        }
      }
    }

    this.connection.close()
    try {
      this.process.stdin.end()
    } catch (error) {
      failures.push(error)
    }
    for (const waiter of [...this.diagnosticWaiters]) {
      this.removeDiagnosticWaiter(waiter)
      waiter.reject(new Error(`LSP server ${this.id} closed`))
    }

    const remaining = Math.max(0, deadline - Date.now())
    const exited = await waitForExit(this.process, remaining)
    if (!exited) {
      force()
    }
    clearTimeout(closeTimer)
    if (deadlineExceeded) failures.push(controller.signal.reason)
    this.statusValue = "closed"
    if (failures.length > 0) {
      const failure = new AggregateError(failures, `Failed to close LSP server ${this.id} cleanly`)
      this.failureValue ??= failure
      throw failure
    }
  }
}
