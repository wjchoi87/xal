export type SkillSource = "user" | "project"

export interface Skill {
  name: string
  description: string
  body: string
  directory: string
  path: string
  source: SkillSource
}
