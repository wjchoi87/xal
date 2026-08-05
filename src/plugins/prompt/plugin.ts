import type { Plugin } from "../types"

const plugin: Plugin = {
  name: "prompt",
  register(ctx) {
    ctx.registerPrompt({
      id: "identity",
      text: (prompt) => `You are ${prompt.appName}, a coding agent running in the user's terminal.`,
    })
    ctx.registerPrompt({
      id: "environment",
      text: (prompt) => `Platform: ${prompt.platform}. Working directory: ${prompt.cwd}.`,
    })
    ctx.registerPrompt({
      id: "tools",
      text(prompt) {
        if (prompt.tools.length === 0) return "You have no tools available."
        const names = prompt.tools.map((tool) => tool.name).join(", ")
        const guidance = prompt.tools.filter((tool) => tool.prompt).map((tool) => `${tool.name}: ${tool.prompt}`)
        return [`Available tools: ${names}.`, ...guidance].join("\n")
      },
    })
    ctx.registerPrompt({
      id: "conduct",
      text: () =>
        [
          "Tool calls may require the user's approval before they run. If the user denies an action, respect the denial and adjust your approach instead of retrying the same action.",
          "Ground your statements in what you actually observed from tool output. Keep responses concise.",
        ].join("\n"),
    })
  },
}

export default plugin
