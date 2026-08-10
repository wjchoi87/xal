import type { Plugin } from "../types"
import { subAgentTool } from "./tool"

const plugin: Plugin = {
  name: "sub-agents",
  register(ctx) {
    ctx.registerPrompt({
      id: "sub-agent",
      text(prompt) {
        if (prompt.kind !== "subagent") return ""
        return [
          "You are a one-shot sub-agent working for a primary coding agent. Your first user message is the complete assignment; you have no parent conversation history.",
          "Complete only that assignment, work independently with the available tools, and do not ask the user or attempt further delegation.",
          "Return a concise, self-contained final report with the result, evidence, changed files, and verification relevant to the assignment. Report failures clearly.",
        ].join("\n")
      },
    })
    ctx.registerTool(subAgentTool)
  },
}

export default plugin
