const CONTEXT = 3
const MAX_DIFF_INPUT_LINES = 2000
const MAX_EDIT_DEPTH = 1000

export interface UnifiedDiff {
  hunks: string
  added: number
  removed: number
}

interface DiffOp {
  kind: "same" | "add" | "remove"
  text: string
}

function splitLines(text: string): string[] {
  if (!text) return []
  const lines = text.split("\n")
  if (lines.at(-1) === "") lines.pop()
  return lines
}

function backtrack(a: string[], b: string[], trace: number[][], depth: number, offset: number): DiffOp[] {
  const ops: DiffOp[] = []
  let x = a.length
  let y = b.length
  for (let d = depth; d >= 0; d -= 1) {
    const v = trace[d]!
    const k = x - y
    const down = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)
    const prevK = down ? k + 1 : k - 1
    const prevX = v[offset + prevK]!
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      ops.push({ kind: "same", text: a[x - 1]! })
      x -= 1
      y -= 1
    }
    if (d > 0) ops.push(down ? { kind: "add", text: b[prevY]! } : { kind: "remove", text: a[prevX]! })
    x = prevX
    y = prevY
  }
  return ops.reverse()
}

function myers(a: string[], b: string[]): DiffOp[] | undefined {
  const max = Math.min(a.length + b.length, MAX_EDIT_DEPTH)
  const v = new Array<number>(2 * max + 1).fill(0)
  const trace: number[][] = []
  for (let d = 0; d <= max; d += 1) {
    trace.push([...v])
    for (let k = -d; k <= d; k += 2) {
      const down = k === -d || (k !== d && v[max + k - 1]! < v[max + k + 1]!)
      let x = down ? v[max + k + 1]! : v[max + k - 1]! + 1
      let y = x - k
      while (x < a.length && y < b.length && a[x] === b[y]) {
        x += 1
        y += 1
      }
      v[max + k] = x
      if (x >= a.length && y >= b.length) return backtrack(a, b, trace, d, max)
    }
  }
  return undefined
}

function renderHunks(ops: DiffOp[]): UnifiedDiff {
  const include = new Array<boolean>(ops.length).fill(false)
  for (const [index, op] of ops.entries()) {
    if (op.kind === "same") continue
    const from = Math.max(0, index - CONTEXT)
    const to = Math.min(ops.length - 1, index + CONTEXT)
    for (let i = from; i <= to; i += 1) include[i] = true
  }

  const lines: string[] = []
  let added = 0
  let removed = 0
  let oldLine = 1
  let newLine = 1
  let index = 0
  while (index < ops.length) {
    if (!include[index]) {
      oldLine += 1
      newLine += 1
      index += 1
      continue
    }
    const oldStart = oldLine
    const newStart = newLine
    const body: string[] = []
    let oldCount = 0
    let newCount = 0
    while (index < ops.length && include[index]) {
      const op = ops[index]!
      if (op.kind === "same") {
        body.push(` ${op.text}`)
        oldCount += 1
        newCount += 1
        oldLine += 1
        newLine += 1
      } else if (op.kind === "remove") {
        body.push(`-${op.text}`)
        oldCount += 1
        oldLine += 1
        removed += 1
      } else {
        body.push(`+${op.text}`)
        newCount += 1
        newLine += 1
        added += 1
      }
      index += 1
    }
    const oldHeader = oldCount === 0 ? oldStart - 1 : oldStart
    const newHeader = newCount === 0 ? newStart - 1 : newStart
    lines.push(`@@ -${oldHeader},${oldCount} +${newHeader},${newCount} @@`, ...body)
  }
  return { hunks: lines.join("\n"), added, removed }
}

export function unifiedDiff(oldText: string, newText: string): UnifiedDiff {
  const oldLines = splitLines(oldText)
  const newLines = splitLines(newText)

  let prefix = 0
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1
  let suffix = 0
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1
  }

  const oldMiddle = oldLines.slice(prefix, oldLines.length - suffix)
  const newMiddle = newLines.slice(prefix, newLines.length - suffix)
  if (oldMiddle.length === 0 && newMiddle.length === 0) return { hunks: "", added: 0, removed: 0 }

  const middleOps =
    oldMiddle.length > MAX_DIFF_INPUT_LINES || newMiddle.length > MAX_DIFF_INPUT_LINES
      ? undefined
      : myers(oldMiddle, newMiddle)
  const fallback: DiffOp[] = [
    ...oldMiddle.map((text): DiffOp => ({ kind: "remove", text })),
    ...newMiddle.map((text): DiffOp => ({ kind: "add", text })),
  ]
  const ops: DiffOp[] = [
    ...oldLines.slice(0, prefix).map((text): DiffOp => ({ kind: "same", text })),
    ...(middleOps ?? fallback),
    ...oldLines.slice(oldLines.length - suffix).map((text): DiffOp => ({ kind: "same", text })),
  ]
  return renderHunks(ops)
}
