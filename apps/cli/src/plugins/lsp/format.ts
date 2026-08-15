import { fileURLToPath } from "node:url"
import { asNumber, asString, isJsonObject, isRecord, type JsonObject } from "../../lib/json"
import { displayPath } from "../../lib/path"

const MAX_ITEMS = 250

interface Position {
  line: number
  character: number
}

interface Range {
  start: Position
  end: Position
}

interface Location {
  uri: string
  range: Range
}

const symbolKinds = [
  "File",
  "Module",
  "Namespace",
  "Package",
  "Class",
  "Method",
  "Property",
  "Field",
  "Constructor",
  "Enum",
  "Interface",
  "Function",
  "Variable",
  "Constant",
  "String",
  "Number",
  "Boolean",
  "Array",
  "Object",
  "Key",
  "Null",
  "Enum member",
  "Struct",
  "Event",
  "Operator",
  "Type parameter",
]

function position(value: unknown): Position | undefined {
  if (!isRecord(value)) return undefined
  const line = asNumber(value.line)
  const character = asNumber(value.character)
  if (line === undefined || character === undefined || !Number.isInteger(line) || !Number.isInteger(character)) {
    return undefined
  }
  if (line < 0 || character < 0) return undefined
  return { line, character }
}

function range(value: unknown): Range | undefined {
  if (!isRecord(value)) return undefined
  const start = position(value.start)
  const end = position(value.end)
  return start && end ? { start, end } : undefined
}

function location(value: unknown): Location | undefined {
  if (!isRecord(value)) return undefined
  const uri = asString(value.uri) ?? asString(value.targetUri)
  const valueRange = range(value.range) ?? range(value.targetSelectionRange) ?? range(value.targetRange)
  return uri && valueRange ? { uri, range: valueRange } : undefined
}

function pathOf(uri: string, cwd: string): string {
  if (!uri.startsWith("file:")) return uri
  try {
    return displayPath(fileURLToPath(uri), cwd)
  } catch {
    return uri
  }
}

function point(value: Position): string {
  return `${value.line + 1}:${value.character + 1}`
}

function locationText(value: Location, cwd: string): string {
  const start = point(value.range.start)
  const end = point(value.range.end)
  return `${pathOf(value.uri, cwd)}:${start}-${end}`
}

function items(value: unknown): unknown[] {
  if (value === null || value === undefined) return []
  return Array.isArray(value) ? value : [value]
}

function malformed(name: string): never {
  throw new Error(`language server returned a malformed ${name} result`)
}

function bounded(header: string, lines: string[]): string {
  const shown = lines.slice(0, MAX_ITEMS)
  if (shown.length === lines.length) return [header, ...shown].join("\n")
  return [header, ...shown, `... ${lines.length - shown.length} more results omitted`].join("\n")
}

function plural(count: number, singular: string, pluralValue = `${singular}s`): string {
  return count === 1 ? singular : pluralValue
}

export function formatLocations(value: unknown, cwd: string, name: string, pluralName = `${name}s`): string {
  const locations = items(value).map((entry) => {
    const parsed = location(entry)
    return parsed ?? malformed(name)
  })
  const unique = [...new Map(locations.map((entry) => [locationText(entry, cwd), entry])).values()]
  if (unique.length === 0) return `No ${pluralName} found`
  return bounded(
    `Found ${unique.length} ${plural(unique.length, name, pluralName)}`,
    unique.map((entry) => locationText(entry, cwd)),
  )
}

function hoverPart(value: unknown): string | undefined {
  if (typeof value === "string") return value
  if (!isRecord(value)) return undefined
  const text = asString(value.value)
  if (text === undefined) return undefined
  const language = asString(value.language)
  return language ? `\`\`\`${language}\n${text}\n\`\`\`` : text
}

export function formatHover(value: unknown): string {
  if (value === null || value === undefined) return "No hover information found"
  if (!isRecord(value)) malformed("hover")
  const contents = Array.isArray(value.contents) ? value.contents : [value.contents]
  const text = contents
    .map((entry) => {
      const part = hoverPart(entry)
      return part ?? malformed("hover")
    })
    .filter((part) => part.length > 0)
  if (text.length === 0) return "No hover information found"
  return `Hover information\n${text.join("\n\n")}`
}

function symbolKind(value: unknown): string | undefined {
  const kind = asNumber(value)
  if (kind === undefined || !Number.isInteger(kind) || kind < 1) return undefined
  return symbolKinds[kind - 1] ?? `Symbol ${kind}`
}

function symbolLocation(value: Record<string, unknown>, fallbackUri: string): Location | undefined {
  const directRange = range(value.selectionRange) ?? range(value.range)
  if (directRange) return { uri: fallbackUri, range: directRange }
  return location(value.location)
}

function symbolLines(value: unknown, cwd: string, fallbackUri: string, depth = 0): string[] {
  if (!isRecord(value)) malformed("symbol")
  const name = asString(value.name)
  const at = symbolLocation(value, fallbackUri)
  const kind = symbolKind(value.kind)
  if (!name || !at || !kind) malformed("symbol")
  const detail = asString(value.detail) ?? asString(value.containerName)
  const current = `${"  ".repeat(depth)}${locationText(at, cwd)} · ${kind} · ${name}${detail ? ` — ${detail}` : ""}`
  if (value.children !== undefined && !Array.isArray(value.children)) malformed("symbol")
  const children = Array.isArray(value.children)
    ? value.children.flatMap((child) => symbolLines(child, cwd, fallbackUri, depth + 1))
    : []
  return [current, ...children]
}

export function formatSymbols(value: unknown, cwd: string, fallbackUri: string): string {
  const lines = items(value).flatMap((entry) => symbolLines(entry, cwd, fallbackUri))
  if (lines.length === 0) return "No symbols found"
  return bounded(`Found ${lines.length} ${plural(lines.length, "symbol")}`, lines)
}

export function firstCallHierarchyItem(value: unknown): JsonObject | undefined {
  if (value === null || value === undefined || (Array.isArray(value) && value.length === 0)) return undefined
  const candidate = Array.isArray(value) ? value[0] : value
  return isJsonObject(candidate) && callItem(candidate) ? candidate : malformed("call hierarchy")
}

function callItem(value: unknown): { name: string; kind: string; location: Location } | undefined {
  if (!isRecord(value)) return undefined
  const name = asString(value.name)
  const uri = asString(value.uri)
  const itemRange = range(value.selectionRange)
  const fullRange = range(value.range)
  const kind = symbolKind(value.kind)
  if (!name || !uri || !itemRange || !fullRange || !kind) return undefined
  return { name, kind, location: { uri, range: itemRange } }
}

export function formatCalls(value: unknown, cwd: string, direction: "incoming" | "outgoing"): string {
  const lines = items(value).map((entry) => {
    if (!isRecord(entry)) malformed("call hierarchy")
    const parsed = callItem(direction === "incoming" ? entry.from : entry.to)
    if (!parsed) malformed("call hierarchy")
    return `${locationText(parsed.location, cwd)} · ${parsed.kind} · ${parsed.name}`
  })
  if (lines.length === 0) return `No ${direction} calls found`
  return bounded(`Found ${lines.length} ${direction} ${plural(lines.length, "call")}`, lines)
}

function diagnosticSeverity(value: unknown): string {
  switch (asNumber(value)) {
    case 1:
      return "error"
    case 2:
      return "warning"
    case 3:
      return "information"
    case 4:
      return "hint"
    default:
      return "diagnostic"
  }
}

function diagnosticCode(value: unknown): string | undefined {
  if (typeof value === "string" || typeof value === "number") return String(value)
  if (!isRecord(value)) return undefined
  return typeof value.value === "string" || typeof value.value === "number" ? String(value.value) : undefined
}

export function formatDiagnostics(value: unknown, uri: string, cwd: string): string {
  const lines = items(value).map((entry) => {
    if (!isRecord(entry)) malformed("diagnostic")
    const rawMessage = asString(entry.message)
    const diagnosticRange = range(entry.range)
    if (rawMessage === undefined || !diagnosticRange) malformed("diagnostic")
    const message = rawMessage.replace(/\s+/g, " ").trim() || "(empty message)"
    const source = asString(entry.source)
    const code = diagnosticCode(entry.code)
    const label = [source, code].filter((part) => part !== undefined).join(" ")
    const at = locationText({ uri, range: diagnosticRange }, cwd)
    return `${at}: ${diagnosticSeverity(entry.severity)}${label ? ` [${label}]` : ""}: ${message}`
  })
  if (lines.length === 0) return "No diagnostics found"
  return bounded(`Found ${lines.length} ${plural(lines.length, "diagnostic")}`, lines)
}
