import { homedir } from "node:os"
import { isAbsolute, relative, resolve } from "node:path"

export function resolveFilePath(path: string): string {
  if (path === "~" || path.startsWith("~/")) return resolve(homedir(), path.slice(2))
  return isAbsolute(path) ? path : resolve(process.cwd(), path)
}

export function displayPath(path: string): string {
  if (!path) return ""
  const absolute = resolveFilePath(path)
  const relativePath = relative(process.cwd(), absolute)
  if (!relativePath) return absolute
  return relativePath.startsWith("..") || isAbsolute(relativePath) ? absolute : relativePath
}
