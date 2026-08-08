import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { basename, dirname, join } from "node:path"

export async function readJsonFile(path: string): Promise<unknown> {
  let text: string
  try {
    text = await readFile(path, "utf8")
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined
    throw error
  }
  try {
    const parsed: unknown = JSON.parse(text)
    return parsed
  } catch {
    throw new Error(`${path} is malformed — fix or delete it`)
  }
}

export async function writeSecureJson(path: string, value: unknown): Promise<void> {
  const dir = dirname(path)
  await mkdir(dir, { recursive: true })
  const tmp = join(dir, `.${basename(path)}.${process.pid}.${Date.now()}.tmp`)
  await writeFile(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 })
  await rename(tmp, path)
  await chmod(path, 0o600)
}
