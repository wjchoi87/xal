import { existsSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"

const available = process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec")

export function sandboxAvailable(): boolean {
  return available
}

function profilePath(path: string): string {
  return path.replace(/[\\"]/g, (char) => `\\${char}`)
}

export function sandboxLaunch(launch: string[], workspace: string): string[] {
  const roots = new Set([realpathSync(workspace), realpathSync(tmpdir()), realpathSync("/tmp")])
  const writable = [
    ...[...roots].map((root) => `(subpath "${profilePath(root)}")`),
    '(literal "/dev/null")',
    '(literal "/dev/tty")',
  ]
  const profile = [
    "(version 1)",
    "(allow default)",
    "(deny network*)",
    `(deny file-write* (require-not (require-any ${writable.join(" ")})))`,
  ].join("\n")
  return ["/usr/bin/sandbox-exec", "-p", profile, ...launch]
}
