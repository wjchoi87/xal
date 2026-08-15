import type { Skill } from "./types"

let catalog = new Map<string, Skill>()

export function replaceSkills(skills: Skill[]): void {
  catalog = new Map(skills.map((skill) => [skill.name, skill]))
}

export function getSkill(name: string): Skill | undefined {
  return catalog.get(name)
}

export function listSkills(): Skill[] {
  return [...catalog.values()]
}
