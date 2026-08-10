import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { agentHome, projectConfigPath } from "../../config/paths"
import { findProjectRoot } from "../../project/root"
import { listSkills, replaceSkills } from "../../skills/registry"
import type { Plugin } from "../types"
import { loadSkills } from "./catalog"
import { skillTool } from "./tool"

function catalogPrompt(): string {
  const skills = listSkills()
  if (skills.length === 0) return ""
  const entries = skills.map((skill) => `- ${skill.name}: ${skill.description.replace(/\s+/g, " ")}`)
  return [
    "Reusable skills are available. Their metadata is listed below; full instructions stay out of context until loaded with the skill tool. A user can explicitly invoke one by starting their input with $name.",
    ...entries,
  ].join("\n")
}

const plugin: Plugin = {
  name: "skills",
  register(ctx) {
    replaceSkills([])
    ctx.registerTool(skillTool)
    ctx.registerPrompt({ id: "skills", text: catalogPrompt })
  },
  async bootstrap() {
    const root = await findProjectRoot(process.cwd())
    replaceSkills(
      await loadSkills([
        { directory: join(homedir(), ".agents", "skills"), source: "user" },
        { directory: join(agentHome(), "skills"), source: "user" },
        { directory: join(root, ".agents", "skills"), source: "project" },
        { directory: join(dirname(projectConfigPath(root)), "skills"), source: "project" },
      ]),
    )
  },
}

export default plugin
