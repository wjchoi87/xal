import type { JsonObject, JsonValue } from "../lib/json"
import { isRecord } from "../lib/json"

export const REDACTION_MARKER = "[REDACTED]"

class SecretRedactor {
  private readonly sources = new Map<string, string[]>()
  private values: string[] = []
  private marker = REDACTION_MARKER

  replace(source: string, values: string[]): void {
    this.sources.set(
      source,
      values.filter((value) => value.length > 0),
    )
    this.values = [...new Set([...this.sources.values()].flat())].sort(
      (left, right) => right.length - left.length || left.localeCompare(right),
    )
    const marker = [REDACTION_MARKER, "<hidden>", "***", "•••", "_"].find((marker) =>
      this.values.every((value) => !marker.includes(value) && !value.includes(marker)),
    )
    if (marker !== undefined) {
      this.marker = marker
      return
    }
    for (let codePoint = 0xe000; codePoint <= 0xf8ff; codePoint++) {
      const alternate = String.fromCodePoint(codePoint)
      if (this.values.every((value) => !value.includes(alternate))) {
        this.marker = alternate
        return
      }
    }
    throw new Error("secret redaction marker resolution failed")
  }

  text(text: string): string {
    if (this.values.length === 0) return text
    let redacted = ""
    let cursor = 0
    while (cursor < text.length) {
      if (this.marker && text.startsWith(this.marker, cursor)) {
        redacted += this.marker
        cursor += this.marker.length
        continue
      }
      const matched = this.values.find((value) => text.startsWith(value, cursor))
      if (matched) {
        redacted += this.marker
        cursor += matched.length
        continue
      }
      redacted += text.slice(cursor, cursor + 1)
      cursor++
    }
    return redacted
  }

  split(text: string): { safe: string; pending: string } {
    let retained = 0
    const protectedValues = this.marker ? [this.marker, ...this.values] : this.values

    for (const value of protectedValues) {
      const limit = Math.min(text.length, value.length - 1)
      for (let length = limit; length > retained; length--) {
        if (!text.endsWith(value.slice(0, length))) continue
        retained = length
        break
      }
    }

    let boundary = text.length - retained
    let changed = true
    while (changed) {
      changed = false
      for (const value of protectedValues) {
        let start = text.indexOf(value)
        while (start >= 0 && start < boundary) {
          if (start + value.length > boundary) {
            boundary = start
            changed = true
            break
          }
          start = text.indexOf(value, start + 1)
        }
      }
    }

    if (boundary === text.length) return { safe: this.text(text), pending: "" }
    return {
      safe: this.text(text.slice(0, boundary)),
      pending: text.slice(boundary),
    }
  }
}

export class RedactedStream {
  private pending = ""

  write(text: string): string {
    const split = redactor.split(this.pending + text)
    this.pending = split.pending
    return split.safe
  }

  end(): string {
    const tail = redactor.text(this.pending)
    this.pending = ""
    return tail
  }
}

const redactor = new SecretRedactor()
const enteredSecrets = new Set<string>()

export function protectSecretValue(value: string): void {
  enteredSecrets.add(value)
  enteredSecrets.add(value.trim())
  replaceSecretValues("entered", [...enteredSecrets])
}

export function replaceSecretValues(source: string, values: string[]): void {
  redactor.replace(source, values)
}

export function redactText(text: string): string {
  return redactor.text(text)
}

export function createRedactedStream(): RedactedStream {
  return new RedactedStream()
}

function redactJsonValue(value: JsonValue): JsonValue {
  if (typeof value === "string") return redactText(value)
  if (!Array.isArray(value) && !isRecord(value)) return value

  if (Array.isArray(value)) {
    const redacted = value.map(redactJsonValue)
    return redacted.some((entry, index) => entry !== value[index]) ? redacted : value
  }

  let changed = false
  const redacted: JsonObject = {}
  for (const [key, entry] of Object.entries(value)) {
    const nextKey = redactText(key)
    const next = redactJsonValue(entry)
    redacted[nextKey] = next
    if (nextKey !== key || next !== entry) changed = true
  }
  return changed ? redacted : value
}

export function redactJsonObject(value: JsonObject): JsonObject {
  const redacted = redactJsonValue(value)
  return Array.isArray(redacted) || !isRecord(redacted) ? value : redacted
}

function redactUnknown(value: unknown): unknown {
  if (typeof value === "string") return redactText(value)
  if (Array.isArray(value)) return value.map(redactUnknown)
  if (!isRecord(value)) return value
  return redactRecord(value)
}

export function redactRecord(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [redactText(key), redactUnknown(entry)]))
}
