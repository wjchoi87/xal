import { spawn } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { appInfo } from "../../app-info"

export function externalEditorCommand(): string {
  const command = process.env.VISUAL?.trim() || process.env.EDITOR?.trim()
  if (!command) throw new Error("external editor is not configured — set VISUAL or EDITOR")
  return command
}

function runEditor(command: string, file: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child =
      process.platform === "win32"
        ? spawn(command, [file], { shell: true, stdio: "inherit" })
        : spawn("/bin/sh", ["-c", `exec ${command} "$1"`, `${appInfo.name}-editor`, file], { stdio: "inherit" })

    child.once("error", reject)
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolve()
        return
      }
      if (signal) {
        reject(new Error(`external editor stopped by ${signal}`))
        return
      }
      reject(new Error(`external editor exited with code ${code ?? "unknown"}`))
    })
  })
}

export async function editInExternalEditor(command: string, content: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `${appInfo.name}-editor-`))
  const file = join(directory, "prompt.md")
  try {
    await writeFile(file, content, { encoding: "utf8", mode: 0o600 })
    await runEditor(command, file)
    return await readFile(file, "utf8")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
