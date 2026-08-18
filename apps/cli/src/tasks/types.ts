import { asString, isRecord } from "../lib/json"

export const MAX_TASKS = 8
export const MAX_TASK_STEP_LENGTH = 160

export type TaskStatus = "pending" | "in_progress" | "completed"

export interface TrackedTask {
  step: string
  status: TaskStatus
}

export interface TaskListUpdatedEvent {
  type: "task_list_updated"
  tasks: TrackedTask[]
}

export function isTaskStatus(value: unknown): value is TaskStatus {
  return value === "pending" || value === "in_progress" || value === "completed"
}

export function taskListCompleted(tasks: TrackedTask[]): boolean {
  return tasks.length > 0 && tasks.every((task) => task.status === "completed")
}

function parseTask(value: unknown): TrackedTask | undefined {
  if (!isRecord(value)) return undefined
  const step = asString(value.step)?.trim()
  const status = asString(value.status)
  if (!step || step.length > MAX_TASK_STEP_LENGTH || !isTaskStatus(status)) return undefined
  return { step, status }
}

export function parseTaskList(value: unknown): TrackedTask[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_TASKS) return undefined
  const tasks = value.flatMap((entry) => {
    const task = parseTask(entry)
    return task ? [task] : []
  })
  if (tasks.length !== value.length) return undefined
  if (tasks.filter((task) => task.status === "in_progress").length > 1) return undefined
  if (new Set(tasks.map((task) => task.step.toLowerCase())).size !== tasks.length) return undefined
  return tasks
}
