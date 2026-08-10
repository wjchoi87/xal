import { MAX_TASKS, MAX_TASK_STEP_LENGTH, parseTaskList, type TrackedTask } from "../../tasks/types"
import type { Tool } from "../../tools/types"

function tasksFrom(args: Record<string, unknown>): TrackedTask[] {
  const tasks = parseTaskList(args.tasks)
  if (tasks) return tasks
  throw new Error(
    `tasks must contain up to ${MAX_TASKS} unique steps of at most ${MAX_TASK_STEP_LENGTH} characters, with no more than one in progress`,
  )
}

export const updateTasksTool: Tool = {
  name: "update_tasks",
  description:
    "Replace the session task list with an ordered set of pending, in-progress, and completed steps. Send an empty list to clear it.",
  parameters: {
    type: "object",
    properties: {
      tasks: {
        type: "array",
        maxItems: MAX_TASKS,
        items: {
          type: "object",
          properties: {
            step: { type: "string", minLength: 1, maxLength: MAX_TASK_STEP_LENGTH },
            status: { type: "string", enum: ["pending", "in_progress", "completed"] },
          },
          required: ["step", "status"],
          additionalProperties: false,
        },
      },
    },
    required: ["tasks"],
    additionalProperties: false,
  },
  prompt:
    "Use update_tasks for work with several meaningful steps. Replace the whole list whenever progress changes, keep at most one step in progress, and skip it for short one-step work.",
  title(args) {
    const count = Array.isArray(args.tasks) ? args.tasks.length : 0
    if (count === 0) return "Clear task list"
    return `Update ${count} ${count === 1 ? "task" : "tasks"}`
  },
  readOnly() {
    return true
  },
  async execute(args) {
    const tasks = tasksFrom(args)
    return {
      output: JSON.stringify({ tasks }),
      events: [{ type: "task_list_updated", tasks }],
    }
  },
}
