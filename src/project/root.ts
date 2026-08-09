import { stat } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { isMissingPathError } from "../lib/error"

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (isMissingPathError(error)) return false
    throw error
  }
}

export async function findProjectRoot(cwd: string): Promise<string> {
  const start = resolve(cwd)
  let directory = start
  while (true) {
    if (await pathExists(join(directory, ".git"))) return directory
    const parent = dirname(directory)
    if (parent === directory) return start
    directory = parent
  }
}
