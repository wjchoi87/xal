import { getSkill } from "./registry"

export interface SkillReference {
  name: string
  start: number
  end: number
}

export interface SkillQuery {
  start: number
  end: number
  query: string
}

export function findSkillReferences(text: string): SkillReference[] {
  return [...text.matchAll(/\$([a-z0-9]+(?:-[a-z0-9]+)*)/g)].flatMap((match) => {
    const name = match[1]
    if (!name || match.index === undefined || !getSkill(name)) return []
    return [{ name, start: match.index, end: match.index + match[0].length }]
  })
}

export function skillQuery(text: string, cursor: number): SkillQuery | undefined {
  const prefix = text.slice(0, cursor)
  const start = prefix.lastIndexOf("$")
  if (start < 0) return undefined
  const query = prefix.slice(start + 1)
  if (/\s/.test(query)) return undefined
  return { start, end: cursor, query }
}
