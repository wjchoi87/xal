import { dirname } from "node:path"
import { asString } from "../../lib/json"
import { displayPath } from "../../lib/path"
import type { ToolPermission } from "../../tools/types"

export function pathPermission(tool: string, args: Record<string, unknown>): ToolPermission {
  const subject = displayPath(asString(args.file_path) ?? "")
  const dir = dirname(subject)
  if (!subject || dir === "." || dir === subject) return { subject, suggestion: `${tool}(${subject})` }
  return { subject, suggestion: `${tool}(${dir}/*)` }
}
