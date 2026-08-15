import { homedir } from "node:os"
import { isAbsolute, relative, resolve } from "node:path"

export function resolveFilePath(path: string, cwd: string): string {
  if (path === "~" || path.startsWith("~/")) return resolve(homedir(), path.slice(2))
  return isAbsolute(path) ? path : resolve(cwd, path)
}

export function compactPath(path: string): string {
  const home = homedir()
  if (path !== home && !path.startsWith(`${home}/`)) return path
  return `~${path.slice(home.length)}`
}

export function displayPath(path: string, cwd: string): string {
  if (!path) return ""
  const absolute = resolveFilePath(path, cwd)
  const relativePath = relative(cwd, absolute)
  if (!relativePath) return absolute
  return relativePath.startsWith("..") || isAbsolute(relativePath) ? absolute : relativePath
}
