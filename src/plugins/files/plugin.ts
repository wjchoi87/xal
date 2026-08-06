import type { Plugin } from "../types"
import { editTool } from "./edit"
import { readTool } from "./read"
import { writeTool } from "./write"

function toolFailed(output: string): boolean {
  return output.startsWith("Tool failed:")
}

function summarizeDiff(output: string): string {
  if (toolFailed(output)) return "failed"
  const first = output.split("\n", 1)[0] ?? ""
  const created = /^Created .+ \((\d+) lines\)$/.exec(first)
  if (created) return `+${created[1]} −0`
  const updated = /^Updated .+ \(\+(\d+) -(\d+)\)$/.exec(first)
  if (updated) return `+${updated[1]} −${updated[2]}`
  return "no changes"
}

const plugin: Plugin = {
  name: "files",
  register(ctx) {
    ctx.registerTool(readTool)
    ctx.registerTool(writeTool)
    ctx.registerTool(editTool)
    ctx.registerPermissionRules({ ask: ["write(/*)", "edit(/*)"] })
    ctx.registerToolRenderer({ tool: "read", failed: toolFailed })
    ctx.registerToolRenderer({
      tool: "write",
      alwaysExpanded: true,
      maxRows: 250,
      failed: toolFailed,
      summarize: summarizeDiff,
    })
    ctx.registerToolRenderer({
      tool: "edit",
      alwaysExpanded: true,
      maxRows: 250,
      failed: toolFailed,
      summarize: summarizeDiff,
    })
  },
}

export default plugin
