import { createHash } from "node:crypto"
import { lstat, mkdir, open, readFile, unlink, type FileHandle } from "node:fs/promises"
import { dirname } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { isMissingPathError } from "../../lib/error"
import { writeSecureText } from "../../lib/fs"
import { asString, isRecord } from "../../lib/json"
import { redactText } from "../../secrets/redactor"

const MAX_BYTES = 16 * 1024
const encoder = new TextEncoder()

export interface MemorySnapshot {
  content: string
  revision: string
}

function revision(content: string): string {
  return createHash("sha256").update(content).digest("hex")
}

export class GlobalMemoryStore {
  private snapshot: MemorySnapshot = { content: "", revision: revision("") }

  constructor(private readonly path: string) {}

  get promptContent(): string {
    return this.snapshot.content
  }

  async load(): Promise<MemorySnapshot> {
    const content = await this.readFile()
    this.validate(content)
    this.snapshot = { content, revision: revision(content) }
    return this.snapshot
  }

  async replace(content: string, expectedRevision: string, signal?: AbortSignal): Promise<MemorySnapshot> {
    this.validate(content)
    return this.withWriteLock(async () => {
      const current = await this.readFile()
      this.validate(current)
      if (revision(current) !== expectedRevision) {
        this.snapshot = { content: current, revision: revision(current) }
        throw new Error("global memory changed since it was read; read it again before replacing it")
      }

      if (content !== current) await writeSecureText(this.path, content)
      this.snapshot = { content, revision: revision(content) }
      return this.snapshot
    }, signal)
  }

  private async withWriteLock<T>(write: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await mkdir(dirname(this.path), { recursive: true })
    const lockPath = `${this.path}.lock`
    const lock = await this.openWriteLock(lockPath, signal)
    try {
      signal?.throwIfAborted()
      return await write()
    } finally {
      try {
        await lock.close()
      } finally {
        await unlink(lockPath)
      }
    }
  }

  private async openWriteLock(lockPath: string, signal?: AbortSignal): Promise<FileHandle> {
    for (let attempt = 0; attempt < 200; attempt++) {
      signal?.throwIfAborted()
      try {
        return await open(lockPath, "wx", 0o600)
      } catch (error) {
        if (!isRecord(error) || asString(error.code) !== "EEXIST") throw error
        if (attempt === 199) {
          throw new Error(`global memory update lock timed out; remove ${lockPath} if no update is running`, {
            cause: error,
          })
        }
        await delay(25, undefined, { signal })
      }
    }
    throw new Error("global memory update lock failed")
  }

  private async readFile(): Promise<string> {
    let metadata
    try {
      metadata = await lstat(this.path)
    } catch (error) {
      if (isMissingPathError(error)) return ""
      throw error
    }
    if (metadata.isSymbolicLink()) throw new Error("global memory path must not be a symbolic link")
    if (!metadata.isFile()) throw new Error("global memory path is not a file")
    if ((metadata.mode & 0o077) !== 0) throw new Error("global memory file permissions must be 0600")
    return readFile(this.path, "utf8")
  }

  private validate(content: string): void {
    if (encoder.encode(content).length > MAX_BYTES) {
      throw new Error(`global memory exceeds its ${MAX_BYTES}-byte limit`)
    }
    if (redactText(content) !== content) {
      throw new Error("global memory contains a configured secret and cannot be used")
    }
  }
}
