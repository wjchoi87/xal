import { join } from "node:path"
import { agentHome } from "../config/paths"
import { readJsonFile, writeSecureJson } from "../lib/fs"
import { asStringArray, isRecord } from "../lib/json"

interface StoreFile {
  version: 1
  projects: Record<string, { allow: string[] }>
}

function permissionsPath(): string {
  return join(agentHome(), "permissions.json")
}

async function loadFile(): Promise<StoreFile> {
  const path = permissionsPath()
  const parsed = await readJsonFile(path)
  if (parsed === undefined) return { version: 1, projects: {} }
  if (!isRecord(parsed) || !isRecord(parsed.projects)) {
    throw new Error(`${path} is malformed — fix or delete it`)
  }
  const projects: Record<string, { allow: string[] }> = {}
  for (const [project, raw] of Object.entries(parsed.projects)) {
    if (!isRecord(raw) || !Array.isArray(raw.allow)) {
      throw new Error(`${path} is malformed — fix or delete it`)
    }
    const allow = asStringArray(raw.allow)
    if (allow.length !== raw.allow.length) {
      throw new Error(`${path} is malformed — fix or delete it`)
    }
    projects[project] = { allow }
  }
  return { version: 1, projects }
}

export async function loadProjectRules(project: string): Promise<string[]> {
  const file = await loadFile()
  return file.projects[project]?.allow ?? []
}

let pending: Promise<void> = Promise.resolve()

export function saveProjectRule(project: string, pattern: string): Promise<void> {
  const write = (): Promise<void> => writeProjectRule(project, pattern)
  pending = pending.then(write, write)
  return pending
}

async function writeProjectRule(project: string, pattern: string): Promise<void> {
  const file = await loadFile()
  const allow = file.projects[project]?.allow ?? []
  if (allow.includes(pattern)) return
  file.projects[project] = { allow: [...allow, pattern] }
  await writeSecureJson(permissionsPath(), file)
}
