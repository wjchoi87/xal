import { runRg } from "../../lib/rg"

export interface FileQuery {
  start: number
  end: number
  query: string
  quoted: boolean
}

function lineRange(text: string, cursor: number): { start: number; end: number } {
  const start = text.lastIndexOf("\n", Math.max(0, cursor - 1)) + 1
  const next = text.indexOf("\n", cursor)
  return { start, end: next < 0 ? text.length : next }
}

export function fileQuery(text: string, cursor: number): FileQuery | undefined {
  const safeCursor = Math.max(0, Math.min(cursor, text.length))
  const line = lineRange(text, safeCursor)
  let start = line.start

  while (start < line.end) {
    while (start < line.end && /\s/.test(text[start] ?? "")) start++
    if (start >= line.end) return undefined

    let end = start
    const quoted = text.startsWith('@"', start)
    if (quoted) {
      const close = text.indexOf('"', start + 2)
      end = close < 0 || close >= line.end ? line.end : close + 1
    } else {
      while (end < line.end && !/\s/.test(text[end] ?? "")) end++
    }

    if (safeCursor > start && safeCursor <= end && text[start] === "@") {
      const queryStart = start + (quoted ? 2 : 1)
      if (safeCursor < queryStart) return undefined
      const queryEnd = quoted && text[end - 1] === '"' ? end - 1 : end
      return { start, end, query: text.slice(queryStart, Math.min(safeCursor, queryEnd)), quoted }
    }
    start = end + 1
  }
}

export function fileMention(path: string, quoted: boolean): string {
  if (/[\r\n"]/.test(path)) throw new Error(`${path} cannot be represented as a composer file mention`)
  return quoted || /\s/.test(path) ? `@"${path}"` : `@${path}`
}

export class WorkspaceFileIndex {
  private cwd: string | undefined
  private files: string[] | undefined
  private pending: Promise<string[]> | undefined
  private abort: AbortController | undefined
  private generation = 0

  load(cwd: string): Promise<string[]> {
    if (cwd !== this.cwd) {
      this.clear()
      this.cwd = cwd
    }
    if (this.files) return Promise.resolve(this.files)
    if (this.pending) return this.pending

    const generation = this.generation
    const abort = new AbortController()
    this.abort = abort
    const pending = runRg(["--files", "--hidden", "--null", "--glob", "!**/.git/**"], cwd, abort.signal, "\0").then(
      (result) => {
        if (result.aborted || generation !== this.generation) return []
        this.files = result.lines.filter((path) => !/[\r\n"]/.test(path))
        return this.files
      },
    )
    this.pending = pending
    const settled = () => {
      if (generation !== this.generation) return
      this.pending = undefined
      this.abort = undefined
    }
    void pending.then(settled, settled)
    return pending
  }

  clear(): void {
    this.generation++
    this.abort?.abort()
    this.cwd = undefined
    this.files = undefined
    this.pending = undefined
    this.abort = undefined
  }
}
