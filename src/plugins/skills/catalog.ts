import { readdir, readFile, realpath, stat } from "node:fs/promises"
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path"
import { isMissingPathError } from "../../lib/error"
import { asString, isRecord } from "../../lib/json"
import type { Skill, SkillSource } from "../../skills/types"

const MAX_SKILL_BYTES = 64 * 1024
const MAX_RESOURCE_BYTES = 50_000

export interface SkillRoot {
  directory: string
  source: SkillSource
}

interface SkillDocument {
  name: string
  description: string
  body: string
}

async function entries(directory: string) {
  try {
    return await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (isMissingPathError(error)) return []
    throw error
  }
}

async function existingStats(path: string) {
  try {
    return await stat(path)
  } catch (error) {
    if (isMissingPathError(error)) return undefined
    throw error
  }
}

async function walkFiles(directory: string, visited = new Set<string>()): Promise<string[]> {
  let canonical: string
  try {
    canonical = await realpath(directory)
  } catch (error) {
    if (isMissingPathError(error)) return []
    throw error
  }
  if (visited.has(canonical)) return []
  visited.add(canonical)

  const found: string[] = []
  const children = (await entries(canonical)).sort((left, right) => left.name.localeCompare(right.name))
  for (const child of children) {
    const path = resolve(canonical, child.name)
    const info = child.isSymbolicLink() ? await existingStats(path) : undefined
    if (child.isDirectory() || info?.isDirectory()) {
      found.push(...(await walkFiles(path, visited)))
      continue
    }
    if (child.isFile() || info?.isFile()) found.push(await realpath(path))
  }
  return found
}

async function findSkillFiles(directory: string): Promise<string[]> {
  return (await walkFiles(directory)).filter((path) => basename(path) === "SKILL.md")
}

function parseSkill(path: string, content: string): SkillDocument {
  const normalized = content
    .replace(/^\uFEFF/, "")
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
  const frontmatter = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(normalized)
  if (!frontmatter) throw new Error(`${path}: SKILL.md must begin with closed YAML frontmatter`)

  let fields: unknown
  try {
    fields = Bun.YAML.parse(frontmatter[1] ?? "")
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`${path}: invalid YAML frontmatter: ${reason}`, { cause: error })
  }
  if (!isRecord(fields)) throw new Error(`${path}: frontmatter must be an object`)

  const name = asString(fields.name)?.trim()
  if (!name || name.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    throw new Error(`${path}: name must use 1-64 lower-case letters, numbers, and single hyphens`)
  }
  if (basename(dirname(path)) !== name) {
    throw new Error(`${path}: parent directory must be named ${name}`)
  }

  const description = asString(fields.description)?.trim()
  if (!description || description.length > 1024) {
    throw new Error(`${path}: description must contain 1-1024 characters`)
  }

  const body = normalized.slice(frontmatter[0].length).trim()
  if (!body) throw new Error(`${path}: skill instructions must not be empty`)
  return { name, description, body }
}

async function loadSkill(path: string, source: SkillSource): Promise<Skill> {
  const info = await stat(path)
  if (info.size > MAX_SKILL_BYTES) throw new Error(`${path}: SKILL.md exceeds ${MAX_SKILL_BYTES} bytes`)
  const document = parseSkill(path, await readFile(path, "utf8"))
  return { ...document, directory: resolve(path, ".."), path, source }
}

async function loadRoot(root: SkillRoot): Promise<Skill[]> {
  const skills = await Promise.all((await findSkillFiles(root.directory)).map((path) => loadSkill(path, root.source)))
  const names = new Set<string>()
  for (const skill of skills) {
    if (names.has(skill.name)) throw new Error(`${root.directory}: duplicate skill name: ${skill.name}`)
    names.add(skill.name)
  }
  return skills
}

export async function loadSkills(roots: SkillRoot[]): Promise<Skill[]> {
  const catalog = new Map<string, Skill>()
  for (const root of roots) {
    for (const skill of await loadRoot(root)) catalog.set(skill.name, skill)
  }
  return [...catalog.values()].sort((left, right) => left.name.localeCompare(right.name))
}

export async function listSkillFiles(skill: Skill): Promise<string[]> {
  return (await walkFiles(skill.directory))
    .filter((path) => path !== skill.path)
    .map((path) => relative(skill.directory, path))
    .filter((path) => path !== ".." && !path.startsWith(`..${sep}`))
}

export async function readSkillResource(skill: Skill, resource: string): Promise<string> {
  if (!resource || isAbsolute(resource)) throw new Error("path must be relative to the skill directory")
  const root = await realpath(skill.directory)
  const candidate = resolve(root, resource)
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
    throw new Error("path must stay inside the skill directory")
  }
  const path = await realpath(candidate).catch((error: unknown) => {
    if (isMissingPathError(error)) throw new Error(`skill file not found: ${resource}`, { cause: error })
    throw error
  })
  if (path !== root && !path.startsWith(`${root}${sep}`)) {
    throw new Error("path must stay inside the skill directory")
  }
  const info = await stat(path)
  if (!info.isFile()) throw new Error(`skill path is not a file: ${resource}`)
  if (info.size > MAX_RESOURCE_BYTES) throw new Error(`skill file exceeds ${MAX_RESOURCE_BYTES} bytes: ${resource}`)
  const content = await readFile(path, "utf8")
  if (content.includes("\u0000")) throw new Error(`skill file is binary: ${resource}`)
  return content
}
