import type { Plugin } from "../types"
import { webfetchTool } from "./fetch"

function summarizeFetch(output: string): string {
  if (output === "(empty response)") return "empty"
  if (output.startsWith("Redirected to ")) return "redirect"
  const bytes = Buffer.byteLength(output)
  if (bytes < 1024) return `${bytes} B`
  return `${(bytes / 1024).toFixed(1)} KB`
}

const plugin: Plugin = {
  name: "web",
  register(ctx) {
    ctx.registerTool(webfetchTool)
    ctx.registerToolRenderer({ tool: webfetchTool.name, summarize: summarizeFetch })
  },
}

export default plugin
