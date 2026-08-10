import { dirname, join } from "node:path"
import { getCommand } from "../../commands/registry"
import type { Command } from "../../commands/types"
import { agentHome, projectConfigPath } from "../../config/paths"
import { findProjectRoot } from "../../project/root"
import type { Plugin } from "../types"
import { expandPromptTemplate, loadPromptTemplates, type PromptTemplate } from "./templates"

function templateCommand(template: PromptTemplate): Command {
  const hint = template.argumentHint ? ` · ${template.argumentHint}` : ""
  return {
    name: template.name,
    describe: `${template.description}${hint}`,
    async run(args, ctx) {
      const sent = ctx.session.send({ text: expandPromptTemplate(template, args), images: [] })
      if (!sent) ctx.print(`cannot run /${template.name} while the session is busy`)
    },
  }
}

const plugin: Plugin = {
  name: "prompt-commands",
  register() {
    return
  },
  async bootstrap(ctx) {
    const root = await findProjectRoot(process.cwd())
    const templates = await loadPromptTemplates(
      join(agentHome(), "commands"),
      join(dirname(projectConfigPath(root)), "commands"),
    )
    for (const template of templates) {
      if (getCommand(template.name))
        throw new Error(`${template.path}: command /${template.name} is already registered`)
    }
    for (const template of templates) ctx.registerCommand(templateCommand(template))
  },
}

export default plugin
