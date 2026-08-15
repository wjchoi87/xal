import { createWriteStream, type WriteStream } from "node:fs"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { describeError } from "../lib/error"

const MAX_LOG_CHARS = 64 * 1024 * 1024

export interface JobLog {
  path: string
  append(text: string): void
  capped(): boolean
  close(): Promise<void>
}

export function createJobLog(directory: string, jobId: string): JobLog {
  const path = join(directory, `${jobId.replace(/[^a-zA-Z0-9_-]/g, "_")}-${crypto.randomUUID()}.log`)
  const buffered: string[] = []
  let stream: WriteStream | undefined
  let failure: string | undefined
  let written = 0
  let capped = false
  const ready = mkdir(directory, { recursive: true, mode: 0o700 })
    .then(() => {
      stream = createWriteStream(path, { flags: "wx", mode: 0o600 })
      stream.on("error", (error) => {
        failure ??= describeError(error)
      })
      for (const chunk of buffered.splice(0)) stream.write(chunk)
    })
    .catch((error: unknown) => {
      failure ??= describeError(error)
    })
  const write = (text: string): void => {
    if (stream) stream.write(text)
    else buffered.push(text)
  }
  return {
    path,
    append(text) {
      if (failure || capped || !text) return
      if (written + text.length > MAX_LOG_CHARS) {
        capped = true
        const room = Math.max(0, MAX_LOG_CHARS - written)
        write(`${text.slice(0, room)}\n... log capped at ${MAX_LOG_CHARS} characters; further output dropped ...\n`)
        return
      }
      written += text.length
      write(text)
    },
    capped: () => capped,
    async close() {
      await ready
      const active = stream
      if (active) {
        await new Promise<void>((resolve) => {
          active.once("error", () => resolve())
          active.end(() => resolve())
        })
      }
      if (failure) throw new Error(failure)
    },
  }
}
