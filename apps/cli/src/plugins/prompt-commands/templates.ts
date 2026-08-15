import { readFile, readdir } from "node:fs/promises"
import { basename, join } from "node:path"
import { isMissingPathError } from "../../lib/error"
import { asString } from "../../lib/json"

export interface PromptTemplate {
  name: string
  description: string
  argumentHint?: string
  body: string
  path: string
}

interface PromptMetadata {
  description?: string
  argumentHint?: string
}

function scalar(raw: string, path: string, key: string): string {
  const value = raw.trim()
  if (!value) throw new Error(`${path}: ${key} must not be empty`)
  if (value.startsWith('"') || value.endsWith('"')) {
    let parsed: unknown
    try {
      parsed = JSON.parse(value)
    } catch {
      throw new Error(`${path}: ${key} has an invalid quoted value`)
    }
    const text = asString(parsed)
    if (text === undefined) throw new Error(`${path}: ${key} must be text`)
    if (text.includes("\n") || text.includes("\r")) throw new Error(`${path}: ${key} must be one line`)
    return text
  }
  if (value.startsWith("'") || value.endsWith("'")) {
    if (!value.startsWith("'") || !value.endsWith("'") || value.length < 2) {
      throw new Error(`${path}: ${key} has an invalid quoted value`)
    }
    return value.slice(1, -1).replaceAll("''", "'")
  }
  return value
}

function metadata(raw: string, path: string): PromptMetadata {
  const values = new Map<string, string>()
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue
    const separator = line.indexOf(":")
    if (separator <= 0) throw new Error(`${path}: invalid frontmatter line: ${line}`)
    const key = line.slice(0, separator).trim()
    if (key !== "description" && key !== "argument-hint") {
      throw new Error(`${path}: unsupported frontmatter field: ${key}`)
    }
    if (values.has(key)) throw new Error(`${path}: duplicate frontmatter field: ${key}`)
    values.set(key, scalar(line.slice(separator + 1), path, key))
  }
  return {
    description: values.get("description"),
    argumentHint: values.get("argument-hint"),
  }
}

function parseTemplate(path: string, name: string, content: string): PromptTemplate {
  const normalized = content.replace(/^\uFEFF/, "").replaceAll("\r\n", "\n")
  let fields: PromptMetadata = {}
  let body = normalized
  if (normalized.startsWith("---\n")) {
    const frontmatter = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(normalized)
    if (!frontmatter) throw new Error(`${path}: frontmatter is not closed`)
    fields = metadata(frontmatter[1] ?? "", path)
    body = normalized.slice(frontmatter[0].length)
  }
  body = body.trim()
  if (!body) throw new Error(`${path}: prompt body must not be empty`)
  return {
    name,
    description: fields.description ?? "run a custom prompt",
    argumentHint: fields.argumentHint,
    body,
    path,
  }
}

async function loadDirectory(directory: string): Promise<PromptTemplate[]> {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (isMissingPathError(error)) return []
    throw error
  }

  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .sort((left, right) => left.name.localeCompare(right.name))

  return Promise.all(
    files.map(async (entry) => {
      const name = basename(entry.name, ".md")
      const path = join(directory, entry.name)
      if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) {
        throw new Error(`${path}: command names must use lower-case letters, numbers, hyphens, or underscores`)
      }
      return parseTemplate(path, name, await readFile(path, "utf8"))
    }),
  )
}

export async function loadPromptTemplates(userDirectory: string, projectDirectory: string): Promise<PromptTemplate[]> {
  const [user, project] = await Promise.all([loadDirectory(userDirectory), loadDirectory(projectDirectory)])
  const templates = new Map(user.map((template) => [template.name, template]))
  for (const template of project) templates.set(template.name, template)
  return [...templates.values()].sort((left, right) => left.name.localeCompare(right.name))
}

export function expandPromptTemplate(template: PromptTemplate, args: string[]): string {
  return template.body.replace(/\$(\$|ARGUMENTS|[1-9]\d*)/g, (_match, placeholder: string) => {
    if (placeholder === "$") return "$"
    if (placeholder === "ARGUMENTS") return args.join(" ")
    return args[Number(placeholder) - 1] ?? ""
  })
}
