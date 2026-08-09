import { sanitize } from "../lib/text"

interface Emphasis {
  bold: boolean
  italic: boolean
  strike: boolean
}

interface InlineSpan {
  text: string
  bold: boolean
  italic: boolean
  strike: boolean
  code: boolean
  link: string | undefined
}

export interface ListItem {
  depth: number
  marker: string
  text: string
}

export type MarkdownBlock =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "code"; language: string; lines: string[] }
  | { kind: "quote"; lines: string[] }
  | { kind: "list"; items: ListItem[] }
  | { kind: "table"; header: string[]; rows: string[][] }
  | { kind: "rule" }

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*$/
const RULE = /^ {0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$/
const QUOTE = /^ {0,3}> ?/
const BULLET = /^(\s*)[-*+]\s+(.*)$/
const ORDERED = /^(\s*)(\d{1,9})[.)]\s+(.*)$/
const OPENS_EMPHASIS = /[\s([{<"'\u2014\u2013]/

export function parseBlocks(source: string): MarkdownBlock[] {
  const lines = sanitize(source).split("\n")
  const blocks: MarkdownBlock[] = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index]!
    if (line.trim() === "") {
      index += 1
      continue
    }

    const fence = FENCE.exec(line)
    if (fence) {
      const marker = fence[1]!
      const code: string[] = []
      index += 1
      while (index < lines.length && !closesFence(lines[index]!, marker)) {
        code.push(lines[index]!)
        index += 1
      }
      index += 1
      blocks.push({ kind: "code", language: fence[2]!.toLowerCase(), lines: code })
      continue
    }

    const heading = HEADING.exec(line)
    if (heading) {
      blocks.push({ kind: "heading", level: heading[1]!.length, text: heading[2]! })
      index += 1
      continue
    }

    if (RULE.test(line)) {
      blocks.push({ kind: "rule" })
      index += 1
      continue
    }

    if (QUOTE.test(line)) {
      const quoted: string[] = []
      while (index < lines.length && QUOTE.test(lines[index]!)) {
        quoted.push(lines[index]!.replace(QUOTE, ""))
        index += 1
      }
      blocks.push({ kind: "quote", lines: quoted })
      continue
    }

    if (opensTable(lines, index)) {
      const header = tableCells(line)
      const piped = line.trim().startsWith("|")
      const rows: string[][] = []
      index += 2
      while (index < lines.length && continuesTable(lines[index]!, piped)) {
        rows.push(tableCells(lines[index]!))
        index += 1
      }
      blocks.push({ kind: "table", header, rows })
      continue
    }

    if (listItem(line)) {
      const items: ListItem[] = []
      while (index < lines.length) {
        const item = listItem(lines[index]!)
        if (item) {
          items.push(item)
          index += 1
          continue
        }
        if (!lines[index]!.startsWith(" ") || lines[index]!.trim() === "") break
        if (opensBlock(lines, index)) break
        items[items.length - 1]!.text += ` ${lines[index]!.trim()}`
        index += 1
      }
      blocks.push({ kind: "list", items })
      continue
    }

    const paragraph = [line.trim()]
    index += 1
    while (index < lines.length && lines[index]!.trim() !== "" && !opensBlock(lines, index)) {
      paragraph.push(lines[index]!.trim())
      index += 1
    }
    blocks.push({ kind: "paragraph", text: paragraph.join(" ") })
  }

  return blocks
}

export function parseInline(text: string): InlineSpan[] {
  const spans: InlineSpan[] = []
  let buffer = ""
  let bold = false
  let italic = false
  let strike = false
  let index = 0

  const flush = (): void => {
    if (!buffer) return
    spans.push({ text: buffer, bold, italic, strike, code: false, link: undefined })
    buffer = ""
  }

  while (index < text.length) {
    const char = text[index]!

    if (char === "\\" && index + 1 < text.length) {
      buffer += text[index + 1]!
      index += 2
      continue
    }

    if (char === "`") {
      const run = runLength(text, index, "`")
      const close = text.indexOf("`".repeat(run), index + run)
      if (close !== -1) {
        flush()
        spans.push({ text: text.slice(index + run, close).trim(), bold, italic, strike, code: true, link: undefined })
        index = close + run
        continue
      }
    }

    if (char === "[" || (char === "!" && text[index + 1] === "[")) {
      const link = parseLink(text, char === "!" ? index + 1 : index)
      if (link) {
        flush()
        spans.push({ text: link.label, bold, italic, strike, code: false, link: link.url })
        index = link.end
        continue
      }
    }

    const marker = emphasisAt(text, index, { bold, italic, strike })
    if (marker) {
      flush()
      if (marker === "~~") strike = !strike
      else if (marker.length === 2) bold = !bold
      else italic = !italic
      index += marker.length
      continue
    }

    buffer += char
    index += 1
  }

  flush()
  return spans
}

function opensBlock(lines: string[], index: number): boolean {
  const line = lines[index]!
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    RULE.test(line) ||
    QUOTE.test(line) ||
    listItem(line) !== undefined ||
    opensTable(lines, index)
  )
}

function closesFence(line: string, marker: string): boolean {
  const trimmed = line.trim()
  return trimmed.length >= marker.length && [...trimmed].every((char) => char === marker[0])
}

function continuesTable(line: string, piped: boolean): boolean {
  const trimmed = line.trim()
  if (!trimmed.includes("|")) return false
  return piped ? trimmed.startsWith("|") : true
}

function opensTable(lines: string[], index: number): boolean {
  const divider = lines[index + 1]
  if (divider === undefined || !lines[index]!.includes("|")) return false
  return /^[\s|:-]+$/.test(divider) && divider.includes("-") && divider.includes("|")
}

function tableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim())
}

function listItem(line: string): ListItem | undefined {
  if (RULE.test(line)) return undefined
  const bullet = BULLET.exec(line)
  if (bullet) return { depth: depthOf(bullet[1]!), marker: "", text: bullet[2]! }
  const ordered = ORDERED.exec(line)
  if (ordered) return { depth: depthOf(ordered[1]!), marker: `${ordered[2]!}.`, text: ordered[3]! }
  return undefined
}

function depthOf(indent: string): number {
  return Math.min(3, Math.floor(indent.replace(/\t/g, "  ").length / 2))
}

function runLength(text: string, index: number, char: string): number {
  let length = 0
  while (text[index + length] === char) length += 1
  return length
}

function emphasisAt(text: string, index: number, active: Emphasis): string | undefined {
  const char = text[index]!
  if (char !== "*" && char !== "_" && char !== "~") return undefined
  const marker = char.repeat(Math.min(runLength(text, index, char), 2))
  if (char === "~" && marker.length === 1) return undefined

  const before = text[index - 1] ?? " "
  const after = text[index + marker.length] ?? " "
  const open = marker === "~~" ? active.strike : marker.length === 2 ? active.bold : active.italic
  if (open) return /\s/.test(before) ? undefined : marker
  if (/\s/.test(after) || !OPENS_EMPHASIS.test(before)) return undefined
  return marker
}

function parseLink(text: string, index: number): { label: string; url: string; end: number } | undefined {
  const close = text.indexOf("]", index)
  if (close === -1 || text[close + 1] !== "(") return undefined
  const end = text.indexOf(")", close + 2)
  if (end === -1) return undefined
  return { label: text.slice(index + 1, close), url: text.slice(close + 2, end).trim(), end: end + 1 }
}
