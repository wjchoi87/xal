import { displayPath, resolveFilePath } from "../../lib/path"

export { runRg } from "../../lib/rg"

const MAX_OUTPUT_CHARS = 30_000

export function targetArgs(path: string | undefined, cwd: string): string[] {
  if (!path) return []
  if (resolveFilePath(path, cwd) === cwd) return []
  return [displayPath(path, cwd)]
}

export function formatResults(
  header: string,
  lines: string[],
  limit: number,
  footer: (shown: number, total: number) => string,
): string {
  const total = lines.length
  const shown = lines.slice(0, limit)
  let chars = shown.reduce((sum, line) => sum + line.length + 1, 0)
  while (shown.length > 1 && chars > MAX_OUTPUT_CHARS) {
    chars -= (shown.pop()?.length ?? 0) + 1
  }
  if (shown.length === total) return [header, ...shown].join("\n")
  return [header, ...shown, footer(shown.length, total)].join("\n")
}
