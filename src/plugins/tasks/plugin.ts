import { isRecord } from "../../lib/json"
import { parseTaskList } from "../../tasks/types"
import type { Plugin } from "../types"
import { updateTasksTool } from "./tool"

function summarize(output: string): string | undefined {
  let result: unknown
  try {
    result = JSON.parse(output)
  } catch {
    return undefined
  }
  if (!isRecord(result)) return undefined
  const tasks = parseTaskList(result.tasks)
  if (!tasks) return undefined
  if (tasks.length === 0) return "cleared"
  const completed = tasks.filter((task) => task.status === "completed").length
  const active = tasks.some((task) => task.status === "in_progress") ? " · active" : ""
  return `${completed}/${tasks.length} done${active}`
}

const plugin: Plugin = {
  name: "tasks",
  register(ctx) {
    ctx.registerTool(updateTasksTool)
    ctx.registerToolRenderer({
      tool: updateTasksTool.name,
      summarize: (output) => summarize(output) ?? "invalid result",
      failed: (output) => summarize(output) === undefined,
    })
  },
}

export default plugin
