import { isRecord } from "../../lib/json"
import type { Plugin } from "../types"
import { requestUserInputTool } from "./tool"

function summarize(output: string): string | undefined {
  let result: unknown
  try {
    result = JSON.parse(output)
  } catch {
    return undefined
  }
  if (!isRecord(result)) return undefined
  if (result.status === "rejected") return "declined"
  if (result.status !== "answered" || !isRecord(result.answers)) return undefined
  if (Object.values(result.answers).some((answer) => typeof answer !== "string")) return undefined
  const count = Object.keys(result.answers).length
  return `${count} ${count === 1 ? "answer" : "answers"}`
}

const plugin: Plugin = {
  name: "ask",
  register(ctx) {
    ctx.registerTool(requestUserInputTool)
    ctx.registerToolRenderer({
      tool: requestUserInputTool.name,
      summarize: (output) => summarize(output) ?? "invalid result",
      failed: (output) => summarize(output) === undefined,
    })
  },
}

export default plugin
