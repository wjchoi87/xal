import type { Readable, Writable } from "node:stream"
import { asNumber, asString, isRecord, type JsonObject, type JsonValue } from "../../lib/json"

const MAX_HEADER_BYTES = 8 * 1024
const MAX_CONTENT_BYTES = 16 * 1024 * 1024
const MAX_WRITE_TIMEOUT_MS = 5_000

type JsonRpcId = number | string

interface PendingRequest {
  resolve(value: JsonValue): void
  reject(error: unknown): void
  timer: ReturnType<typeof setTimeout>
  signal?: AbortSignal
  abort?: () => void
}

export interface JsonRpcConnectionOptions {
  readable: Readable
  writable: Writable
  timeoutMs: number
  onNotification(method: string, params: JsonValue | undefined): void | Promise<void>
  onRequest(method: string, params: JsonValue | undefined): JsonValue | Promise<JsonValue>
  onFailure(error: unknown): void
}

export class JsonRpcRequestError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: JsonValue,
  ) {
    super(message)
    this.name = "JsonRpcRequestError"
  }
}

export class JsonRpcResponseError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: JsonValue,
  ) {
    super(message)
    this.name = "JsonRpcResponseError"
  }
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true
  if (typeof value === "string" || typeof value === "boolean") return true
  if (typeof value === "number") return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isJsonValue)
  return isRecord(value) && Object.values(value).every(isJsonValue)
}

function rpcId(value: unknown): JsonRpcId | undefined {
  if (typeof value === "string") return value
  if (typeof value === "number" && Number.isInteger(value)) return value
  return undefined
}

function abortError(signal: AbortSignal): Error {
  const error = new Error("LSP request was cancelled", { cause: signal.reason })
  error.name = "AbortError"
  return error
}

function frame(value: JsonValue): Buffer {
  const content = Buffer.from(JSON.stringify(value), "utf8")
  return Buffer.concat([Buffer.from(`Content-Length: ${content.byteLength}\r\n\r\n`, "ascii"), content])
}

export class JsonRpcConnection {
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0)
  private contentLength: number | undefined
  private nextId = 1
  private readonly pending = new Map<JsonRpcId, PendingRequest>()
  private readonly closeController = new AbortController()
  private writeRun = Promise.resolve()
  private listening = false
  private closed = false

  private readonly onData = (chunk: unknown): void => {
    const bytes = Buffer.isBuffer(chunk)
      ? chunk
      : typeof chunk === "string"
        ? Buffer.from(chunk)
        : chunk instanceof Uint8Array
          ? Buffer.from(chunk)
          : undefined
    if (!bytes) {
      this.fail(new Error("LSP server emitted a non-byte stdout chunk"))
      return
    }
    this.buffer = this.buffer.length === 0 ? bytes : Buffer.concat([this.buffer, bytes])
    try {
      this.drain()
    } catch (error) {
      this.fail(error)
    }
  }

  private readonly onReadableError = (error: unknown): void => {
    this.fail(new Error("LSP server stdout failed", { cause: error }))
  }

  private readonly onWritableError = (error: unknown): void => {
    this.fail(new Error("LSP server stdin failed", { cause: error }))
  }

  private readonly onReadableEnd = (): void => {
    if (this.closed) return
    const suffix = this.buffer.length > 0 ? ` with ${this.buffer.length} unread bytes` : ""
    this.fail(new Error(`LSP server stdout ended unexpectedly${suffix}`))
  }

  constructor(private readonly options: JsonRpcConnectionOptions) {}

  listen(): void {
    if (this.closed) throw new Error("LSP connection is closed")
    if (this.listening) return
    this.listening = true
    this.options.readable.on("data", this.onData)
    this.options.readable.on("error", this.onReadableError)
    this.options.readable.on("end", this.onReadableEnd)
    this.options.writable.on("error", this.onWritableError)
  }

  request(method: string, params?: JsonValue, signal?: AbortSignal): Promise<JsonValue> {
    if (this.closed) return Promise.reject(new Error("LSP connection is closed"))
    if (signal?.aborted) return Promise.reject(abortError(signal))

    const id = this.nextId++
    const promise = new Promise<JsonValue>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.rejectPending(id, new Error(`LSP request ${method} timed out after ${this.options.timeoutMs}ms`))
        void this.notify("$/cancelRequest", { id }).catch(() => undefined)
      }, this.options.timeoutMs)
      timer.unref()
      const pending: PendingRequest = { resolve, reject, timer, ...(signal ? { signal } : {}) }
      this.pending.set(id, pending)
      if (signal) {
        pending.abort = () => {
          this.rejectPending(id, abortError(signal))
          void this.notify("$/cancelRequest", { id }).catch(() => undefined)
        }
        signal.addEventListener("abort", pending.abort, { once: true })
        if (signal.aborted) pending.abort()
      }
    })

    if (!this.pending.has(id)) return promise
    const message: JsonObject = { jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }
    void this.send(message).catch((error) => this.rejectPending(id, error))
    return promise
  }

  notify(method: string, params?: JsonValue, signal?: AbortSignal): Promise<void> {
    const message: JsonObject = { jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) }
    return this.send(message, signal)
  }

  close(cause: unknown = new Error("LSP connection closed")): void {
    if (this.closed) return
    this.closed = true
    this.closeController.abort(cause)
    if (this.listening) {
      this.options.readable.off("data", this.onData)
      this.options.readable.off("end", this.onReadableEnd)
    }
    for (const id of [...this.pending.keys()]) this.rejectPending(id, cause)
  }

  private drain(): void {
    while (!this.closed) {
      if (this.contentLength === undefined) {
        const delimiter = this.headerDelimiter()
        if (!delimiter) {
          if (this.buffer.length > MAX_HEADER_BYTES) throw new Error("LSP message header exceeds 8192 bytes")
          return
        }
        if (delimiter.index > MAX_HEADER_BYTES) throw new Error("LSP message header exceeds 8192 bytes")
        const header = this.buffer.subarray(0, delimiter.index).toString("ascii")
        this.buffer = this.buffer.subarray(delimiter.index + delimiter.length)
        this.contentLength = this.parseContentLength(header)
      }

      if (this.buffer.length < this.contentLength) return
      const content = this.buffer.subarray(0, this.contentLength)
      this.buffer = this.buffer.subarray(this.contentLength)
      this.contentLength = undefined
      const text = new TextDecoder("utf-8", { fatal: true }).decode(content)
      const value: unknown = JSON.parse(text)
      this.receive(value)
    }
  }

  private headerDelimiter(): { index: number; length: number } | undefined {
    const strict = this.buffer.indexOf("\r\n\r\n")
    if (strict >= 0) return { index: strict, length: 4 }
    const lenient = this.buffer.indexOf("\n\n")
    return lenient >= 0 ? { index: lenient, length: 2 } : undefined
  }

  private parseContentLength(header: string): number {
    const values = header.split(/\r?\n/).flatMap((line) => {
      const separator = line.indexOf(":")
      if (separator < 0) throw new Error("Malformed LSP message header")
      return line.slice(0, separator).trim().toLowerCase() === "content-length"
        ? [line.slice(separator + 1).trim()]
        : []
    })
    if (values.length !== 1 || !/^[1-9]\d*$/.test(values[0] ?? "")) {
      throw new Error("LSP message must contain one positive Content-Length header")
    }
    const length = Number(values[0])
    if (!Number.isSafeInteger(length) || length > MAX_CONTENT_BYTES) {
      throw new Error(`LSP message Content-Length exceeds ${MAX_CONTENT_BYTES} bytes`)
    }
    return length
  }

  private receive(value: unknown): void {
    if (!isRecord(value) || value.jsonrpc !== "2.0") throw new Error("Invalid LSP JSON-RPC message")
    const method = asString(value.method)
    if (method !== undefined) {
      const params = value.params
      if (params !== undefined && !isJsonValue(params)) throw new Error(`Invalid parameters for LSP method ${method}`)
      if (value.id === undefined) {
        void Promise.resolve(this.options.onNotification(method, params)).catch((error) => this.fail(error))
        return
      }
      const id = rpcId(value.id)
      if (id === undefined) throw new Error(`Invalid request ID for LSP method ${method}`)
      void this.respond(id, method, params)
      return
    }

    const id = rpcId(value.id)
    if (id === undefined) throw new Error("Invalid LSP response ID")
    const hasResult = Object.hasOwn(value, "result")
    const hasError = Object.hasOwn(value, "error")
    if (hasResult === hasError) throw new Error("LSP response must contain exactly one of result or error")
    if (hasResult) {
      if (!isJsonValue(value.result)) throw new Error("LSP response result is not valid JSON")
      this.takePending(id)?.resolve(value.result)
      return
    }
    if (!isRecord(value.error)) throw new Error("LSP response error is malformed")
    const code = asNumber(value.error.code)
    const message = asString(value.error.message)
    const rawData = value.error.data
    const data = rawData === undefined || isJsonValue(rawData) ? rawData : undefined
    if (
      code === undefined ||
      !Number.isInteger(code) ||
      message === undefined ||
      (rawData !== undefined && data === undefined)
    ) {
      throw new Error("LSP response error is malformed")
    }
    this.takePending(id)?.reject(new JsonRpcResponseError(code, message, data))
  }

  private async respond(id: JsonRpcId, method: string, params: JsonValue | undefined): Promise<void> {
    try {
      const result = await this.options.onRequest(method, params)
      await this.send({ jsonrpc: "2.0", id, result })
    } catch (error) {
      const responseError =
        error instanceof JsonRpcRequestError ? error : new JsonRpcRequestError(-32603, "Internal error")
      await this.send({
        jsonrpc: "2.0",
        id,
        error: {
          code: responseError.code,
          message: responseError.message,
          ...(responseError.data === undefined ? {} : { data: responseError.data }),
        },
      }).catch((writeError) => this.fail(writeError))
    }
  }

  private send(message: JsonObject, signal?: AbortSignal): Promise<void> {
    if (this.closed) return Promise.reject(new Error("LSP connection is closed"))
    const content = frame(message)
    const run = this.writeRun.then(() => this.write(content, signal))
    this.writeRun = run.catch((error) => this.fail(error))
    return run
  }

  private write(content: Buffer, signal: AbortSignal | undefined): Promise<void> {
    if (this.closed || this.options.writable.destroyed || !this.options.writable.writable) {
      return Promise.reject(new Error("LSP server stdin is not writable"))
    }
    if (signal?.aborted) return Promise.reject(abortError(signal))

    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (error?: unknown): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.closeController.signal.removeEventListener("abort", onClose)
        signal?.removeEventListener("abort", onAbort)
        if (error === undefined) resolve()
        else reject(error)
      }
      const onClose = (): void =>
        finish(
          this.closeController.signal.reason instanceof Error
            ? this.closeController.signal.reason
            : new Error("LSP connection closed", { cause: this.closeController.signal.reason }),
        )
      const onAbort = (): void => finish(signal ? abortError(signal) : new Error("LSP write was cancelled"))
      const timer = setTimeout(
        () =>
          finish(new Error(`LSP write timed out after ${Math.min(this.options.timeoutMs, MAX_WRITE_TIMEOUT_MS)}ms`)),
        Math.min(this.options.timeoutMs, MAX_WRITE_TIMEOUT_MS),
      )
      timer.unref()
      this.closeController.signal.addEventListener("abort", onClose, { once: true })
      signal?.addEventListener("abort", onAbort, { once: true })
      if (this.closeController.signal.aborted) {
        onClose()
        return
      }
      if (signal?.aborted) {
        onAbort()
        return
      }
      try {
        this.options.writable.write(content, (error?: Error | null) => finish(error ?? undefined))
      } catch (error) {
        finish(error)
      }
    })
  }

  private takePending(id: JsonRpcId): PendingRequest | undefined {
    const pending = this.pending.get(id)
    if (!pending) return undefined
    this.pending.delete(id)
    clearTimeout(pending.timer)
    if (pending.signal && pending.abort) pending.signal.removeEventListener("abort", pending.abort)
    return pending
  }

  private rejectPending(id: JsonRpcId, error: unknown): void {
    this.takePending(id)?.reject(error)
  }

  private fail(error: unknown): void {
    if (this.closed) return
    this.close(error)
    this.options.onFailure(error)
  }
}
