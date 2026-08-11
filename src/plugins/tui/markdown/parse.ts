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

interface ParsedLink {
  label: string
  url: string
  end: number
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
const INLINE_LINK = /<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*)>|(?:https?|file):\/\/[^\s<>]+/g

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
    for (const linked of linkify(buffer)) {
      spans.push({ text: linked.text, bold, italic, strike, code: false, link: linked.link })
    }
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

function parseLink(text: string, index: number): ParsedLink | undefined {
  const close = text.indexOf("]", index)
  if (close === -1 || text[close + 1] !== "(") return undefined
  let depth = 0
  let quote: '"' | "'" | undefined
  let angle = false
  let cursor = close + 2
  while (cursor < text.length) {
    const char = text[cursor]!
    if (char === "\\" && cursor + 1 < text.length) {
      cursor += 2
      continue
    }
    if (quote) {
      if (char === quote) quote = undefined
      cursor += 1
      continue
    }
    if (angle) {
      if (char === ">") angle = false
      cursor += 1
      continue
    }
    if (char === "<" && cursor === close + 2) {
      angle = true
      cursor += 1
      continue
    }
    if ((char === '"' || char === "'") && /\s/.test(text[cursor - 1] ?? "")) {
      quote = char
      cursor += 1
      continue
    }
    if (char === "(") {
      depth += 1
      cursor += 1
      continue
    }
    if (char !== ")") {
      cursor += 1
      continue
    }
    if (depth > 0) {
      depth -= 1
      cursor += 1
      continue
    }
    const url = parseLinkDestination(text.slice(close + 2, cursor))
    if (url === undefined) return undefined
    return {
      label: unescapeMarkdown(text.slice(index + 1, close)),
      url,
      end: cursor + 1,
    }
  }
}

function parseLinkDestination(value: string): string | undefined {
  const content = value.trim()
  if (!content) return ""
  if (content.startsWith("<")) {
    const end = content.indexOf(">", 1)
    if (end === -1 || !validLinkTitle(content.slice(end + 1).trim())) return undefined
    return unescapeMarkdown(content.slice(1, end))
  }

  let depth = 0
  let end = 0
  while (end < content.length) {
    const char = content[end]!
    if (char === "\\" && end + 1 < content.length) {
      end += 2
      continue
    }
    if (/\s/.test(char) && depth === 0) break
    if (char === "(") depth += 1
    if (char === ")") depth -= 1
    if (depth < 0) return undefined
    end += 1
  }
  if (depth !== 0 || !validLinkTitle(content.slice(end).trim())) return undefined
  return unescapeMarkdown(content.slice(0, end))
}

function validLinkTitle(value: string): boolean {
  if (!value) return true
  const close = value[0] === "(" ? ")" : value[0]
  if (close !== ")" && close !== '"' && close !== "'") return false
  return value.length >= 2 && value.endsWith(close)
}

function linkify(text: string): { text: string; link: string | undefined }[] {
  const spans: { text: string; link: string | undefined }[] = []
  let cursor = 0
  for (const match of text.matchAll(INLINE_LINK)) {
    if (match[1] === undefined && match.index > 0 && /[A-Za-z0-9_]/.test(text[match.index - 1]!)) continue
    if (match.index > cursor) spans.push({ text: text.slice(cursor, match.index), link: undefined })
    const url = match[1] ?? trimBareLink(match[0])
    spans.push({ text: url, link: url })
    cursor = match.index + (match[1] === undefined ? url.length : match[0].length)
  }
  if (cursor < text.length) spans.push({ text: text.slice(cursor), link: undefined })
  return spans
}

function trimBareLink(value: string): string {
  let end = value.length
  while (end > 0) {
    const char = value[end - 1]!
    if (`.,;:!?"'\``.includes(char)) {
      end -= 1
      continue
    }
    const candidate = value.slice(0, end)
    if (
      (char === ")" && unmatchedClosing(candidate, "(", ")")) ||
      (char === "]" && unmatchedClosing(candidate, "[", "]")) ||
      (char === "}" && unmatchedClosing(candidate, "{", "}"))
    ) {
      end -= 1
      continue
    }
    break
  }
  return value.slice(0, end)
}

function unmatchedClosing(value: string, open: string, close: string): boolean {
  let balance = 0
  for (const char of value) {
    if (char === open) balance += 1
    if (char === close) balance -= 1
  }
  return balance < 0
}

function unescapeMarkdown(value: string): string {
  return value.replace(/\\([!-/:-@[-`{-~])/g, "$1")
}
