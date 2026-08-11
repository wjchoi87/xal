import { existsSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"

const available = process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec")

export type SandboxAccess = "read" | "workspace"

export function sandboxAvailable(): boolean {
  return available
}

function profilePath(path: string): string {
  return path.replace(/[\\"]/g, (char) => `\\${char}`)
}

export function sandboxLaunch(launch: string[], workspace: string, access: SandboxAccess): string[] {
  const roots = new Set([realpathSync(workspace), realpathSync(tmpdir()), realpathSync("/tmp")])
  const nullDevice = '(literal "/dev/null")'
  const writable = [...[...roots].map((root) => `(subpath "${profilePath(root)}")`), nullDevice]
  const fileWrites =
    access === "read"
      ? `(deny file-write* (require-not ${nullDevice}))`
      : `(deny file-write* (require-not (require-any ${writable.join(" ")})))`
  const profile = ["(version 1)", "(allow default)", "(deny network*)", fileWrites].join("\n")
  return ["/usr/bin/sandbox-exec", "-p", profile, ...launch]
}
