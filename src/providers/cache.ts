import { createHash } from "node:crypto"
import { isJsonObject, stableJson } from "../lib/json"
import type { ToolDefinition } from "./types"

export function promptCacheKey(model: string, instructions: string, tools: ToolDefinition[]): string {
  const hash = createHash("sha256").update(model).update("\0").update(instructions)
  for (const tool of tools) {
    if (!isJsonObject(tool.parameters)) throw new Error(`tool ${tool.name} parameters are not valid JSON`)
    hash.update("\0").update(tool.name).update("\0").update(tool.description).update("\0")
    hash.update(stableJson(tool.parameters))
  }
  return hash.digest("hex")
}
