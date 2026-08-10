import { asString } from "../../lib/json"
import { getSkill } from "../../skills/registry"
import type { Skill } from "../../skills/types"
import type { Tool } from "../../tools/types"
import { listSkillFiles, readSkillResource } from "./catalog"

function requiredSkill(args: Record<string, unknown>): Skill {
  const name = asString(args.name)?.trim()
  if (!name) throw new Error("name is required")
  const skill = getSkill(name)
  if (!skill) throw new Error(`unknown skill: ${name}`)
  return skill
}

export async function renderSkill(skill: Skill): Promise<string> {
  const files = await listSkillFiles(skill)
  const resources =
    files.length === 0 ? "Supporting files: none" : `Supporting files:\n${files.map((path) => `- ${path}`).join("\n")}`
  return [`Skill: ${skill.name}`, `Directory: ${skill.directory}`, resources, skill.body].join("\n\n")
}

export const skillTool: Tool = {
  name: "skill",
  description:
    "Load a discovered skill's instructions, or read one supporting text file from its package. Call without path before using a skill.",
  parameters: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Skill name from the available-skills catalog",
      },
      path: {
        type: "string",
        description: "Optional supporting file path relative to the skill directory",
      },
    },
    required: ["name"],
    additionalProperties: false,
  },
  prompt:
    "Use skill when the user explicitly names an available skill or the task clearly matches one. Load its instructions before acting, then read only the supporting files those instructions require.",
  title(args) {
    const name = asString(args.name) ?? ""
    const path = asString(args.path)
    return path ? `${name}/${path}` : name
  },
  readOnly() {
    return true
  },
  concurrency() {
    return "shared"
  },
  async execute(args) {
    const skill = requiredSkill(args)
    const path = asString(args.path)
    if (path !== undefined) return { output: await readSkillResource(skill, path) }
    return { output: await renderSkill(skill) }
  },
}
