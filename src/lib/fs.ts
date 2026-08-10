import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { isMissingPathError } from "./error"

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (isMissingPathError(error)) return false
    throw error
  }
}

export async function readJsonFile(path: string): Promise<unknown> {
  let text: string
  try {
    text = await readFile(path, "utf8")
  } catch (error) {
    if (isMissingPathError(error)) return undefined
    throw error
  }
  try {
    const parsed: unknown = JSON.parse(text)
    return parsed
  } catch {
    throw new Error(`${path} is malformed — fix or delete it`)
  }
}

export async function writeSecureText(path: string, text: string): Promise<void> {
  const dir = dirname(path)
  await mkdir(dir, { recursive: true })
  const tmp = join(dir, `.${basename(path)}.${process.pid}.${Date.now()}.tmp`)
  await writeFile(tmp, text, { mode: 0o600 })
  await rename(tmp, path)
  await chmod(path, 0o600)
}

export function writeSecureJson(path: string, value: unknown): Promise<void> {
  return writeSecureText(path, JSON.stringify(value, null, 2) + "\n")
}
