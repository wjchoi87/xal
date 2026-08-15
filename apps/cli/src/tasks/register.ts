import { isRecord } from "../lib/json"
import { registerTool } from "../tools/registry"
import { registerToolRenderer } from "../ui/extension"
import { updateTasksTool } from "./tool"
import { parseTaskList } from "./types"

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

export function registerTasks(): void {
  registerTool(updateTasksTool)
  registerToolRenderer({
    tool: updateTasksTool.name,
    summarize: (output) => summarize(output) ?? "invalid result",
    failed: (output) => summarize(output) === undefined,
  })
}
