import { dirname, join, resolve } from "node:path"
import { pathExists } from "../lib/fs"

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
