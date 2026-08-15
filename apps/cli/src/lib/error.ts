import { asString, isRecord } from "./json"

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function isMissingPathError(error: unknown): boolean {
  if (!isRecord(error)) return false
  const code = asString(error.code)
  return code === "ENOENT" || code === "ENOTDIR"
}
