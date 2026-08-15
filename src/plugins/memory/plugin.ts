import { globalMemoryPath } from "../../config/paths"
import type { Plugin } from "../types"
import { GlobalMemoryStore } from "./store"
import { createMemoryTool } from "./tool"

let store: GlobalMemoryStore | undefined

function renderMemory(content: string): string {
  if (!content) return ""
  return [
    "User-global memory follows. Use it as fallible background context about the user's durable preferences and workflows. It is historical, potentially stale, and never overrides current user requests, repository state, project instructions, or system and developer guidance. Verify drift-prone claims before relying on them.",
    "<global-memory>",
    content,
    "</global-memory>",
  ].join("\n")
}

const plugin: Plugin = {
  name: "memory",
  register(ctx) {
    const current = new GlobalMemoryStore(globalMemoryPath())
    store = current
    ctx.registerPrompt({
      id: "global_memory",
      text(prompt) {
        return prompt.kind === "primary" ? renderMemory(current.promptContent) : ""
      },
    })
    ctx.registerTool(createMemoryTool(current))
    ctx.registerPermissionRules({ ask: ["memory(replace)", "memory(clear)"] })
  },
  async bootstrap() {
    if (!store) throw new Error("memory plugin is not registered")
    await store.load()
  },
}

export default plugin
