import type { Plugin } from "../types"
import { globTool } from "./glob"
import { grepTool } from "./grep"

function toolFailed(output: string): boolean {
  return output.startsWith("Tool failed:")
}

function summarizeSearch(output: string): string {
  if (toolFailed(output)) return "failed"
  const first = output.split("\n", 1)[0] ?? ""
  const matches = /^Found (\d+) matching lines$/.exec(first)
  if (matches) return `${matches[1]} matches`
  const files = /^Found (\d+) files$/.exec(first)
  if (files) return `${files[1]} files`
  if (first.startsWith("No matches found") || first.startsWith("No files found")) return "no matches"
  return first
}

const plugin: Plugin = {
  name: "search",
  register(ctx) {
    ctx.registerTool(grepTool)
    ctx.registerTool(globTool)
    ctx.registerToolRenderer({ tool: "grep", failed: toolFailed, summarize: summarizeSearch })
    ctx.registerToolRenderer({ tool: "glob", failed: toolFailed, summarize: summarizeSearch })
  },
}

export default plugin
