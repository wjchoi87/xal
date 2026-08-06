import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { configDir } from "../config/paths"
import { asStringArray, isRecord } from "../lib/json"

interface StoreFile {
  version: 1
  projects: Record<string, { allow: string[] }>
}

const emptyFile = (): StoreFile => ({ version: 1, projects: {} })

function permissionsPath(): string {
  return join(configDir(), "permissions.json")
}

async function loadFile(): Promise<StoreFile> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(permissionsPath(), "utf8"))
  } catch {
    return emptyFile()
  }
  if (!isRecord(parsed) || !isRecord(parsed.projects)) return emptyFile()
  const projects: Record<string, { allow: string[] }> = {}
  for (const [project, raw] of Object.entries(parsed.projects)) {
    if (!isRecord(raw)) continue
    const allow = asStringArray(raw.allow)
    if (allow.length > 0) projects[project] = { allow }
  }
  return { version: 1, projects }
}

export async function loadProjectRules(project: string): Promise<string[]> {
  const file = await loadFile()
  return file.projects[project]?.allow ?? []
}

let pending: Promise<void> = Promise.resolve()

export function saveProjectRule(project: string, pattern: string): Promise<void> {
  pending = pending.then(() => writeProjectRule(project, pattern))
  return pending
}

async function writeProjectRule(project: string, pattern: string): Promise<void> {
  const file = await loadFile()
  const allow = file.projects[project]?.allow ?? []
  if (allow.includes(pattern)) return
  file.projects[project] = { allow: [...allow, pattern] }

  const path = permissionsPath()
  const dir = dirname(path)
  await mkdir(dir, { recursive: true })
  const tmp = join(dir, `.permissions.${process.pid}.${Date.now()}.tmp`)
  await writeFile(tmp, JSON.stringify(file, null, 2) + "\n", { mode: 0o600 })
  await rename(tmp, path)
  await chmod(path, 0o600)
}
