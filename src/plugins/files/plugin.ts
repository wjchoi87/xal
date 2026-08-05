import type { Plugin } from "../types"
import { readTool } from "./read"
import { writeTool } from "./write"

function toolFailed(output: string): boolean {
  return output.startsWith("Tool failed:")
}

const plugin: Plugin = {
  name: "files",
  register(ctx) {
    ctx.registerTool(readTool)
    ctx.registerTool(writeTool)
    ctx.registerToolRenderer({ tool: "read", failed: toolFailed })
    ctx.registerToolRenderer({
      tool: "write",
      alwaysExpanded: true,
      maxRows: 250,
      failed: toolFailed,
      summarize(output) {
        if (toolFailed(output)) return "failed"
        const first = output.split("\n", 1)[0] ?? ""
        const created = /^Created .+ \((\d+) lines\)$/.exec(first)
        if (created) return `+${created[1]} −0`
        const updated = /^Updated .+ \(\+(\d+) -(\d+)\)$/.exec(first)
        if (updated) return `+${updated[1]} −${updated[2]}`
        return "no changes"
      },
    })
  },
}

export default plugin
