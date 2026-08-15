import { asString, isRecord } from "../../lib/json"
import { isThinkingEffort, type ThinkingEffort } from "../../providers/types"

export type TaskAccess = "read" | "write"
type TaskIsolation = "shared" | "worktree"

export interface TaskItem {
  name?: string
  task: string
  access: TaskAccess
  isolation: TaskIsolation
  thinking?: ThinkingEffort
}

export const MAX_CONTEXT_LENGTH = 20_000
export const MAX_TASK_LENGTH = 20_000
export const MAX_BATCH_TASKS = 8

const TASK_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/

export function contextFrom(args: Record<string, unknown>): string {
  const context = asString(args.context)?.trim()
  if (!context) throw new Error("context is required")
  if (context.length > MAX_CONTEXT_LENGTH) {
    throw new Error(`context must be at most ${MAX_CONTEXT_LENGTH} characters`)
  }
  return context
}

function accessFrom(value: unknown, index: number): TaskAccess {
  const access = asString(value)
  if (access === "read" || access === "write") return access
  throw new Error(`task ${index + 1} access must be "read" or "write"`)
}

function isolationFrom(value: unknown, index: number): TaskIsolation {
  const isolation = asString(value) ?? "shared"
  if (isolation === "shared" || isolation === "worktree") return isolation
  throw new Error(`task ${index + 1} isolation must be "shared" or "worktree"`)
}

function thinkingFrom(value: unknown, index: number): ThinkingEffort | undefined {
  if (value === undefined) return undefined
  if (isThinkingEffort(value)) return value
  throw new Error(`task ${index + 1} thinking must be one of "none", "low", "medium", "high", "xhigh", or "max"`)
}

function taskFrom(value: unknown, index: number): TaskItem {
  if (!isRecord(value)) throw new Error(`task ${index + 1} must be an object`)
  const task = asString(value.task)?.trim()
  if (!task) throw new Error(`task ${index + 1} is missing task instructions`)
  if (task.length > MAX_TASK_LENGTH) {
    throw new Error(`task ${index + 1} must be at most ${MAX_TASK_LENGTH} characters`)
  }
  const name = asString(value.name)?.trim()
  if (name && !TASK_NAME_PATTERN.test(name)) {
    throw new Error(`task ${index + 1} name must start with a letter and use at most 32 letters, numbers, _ or -`)
  }
  const access = accessFrom(value.access, index)
  const isolation = isolationFrom(value.isolation, index)
  if (isolation === "worktree" && access !== "write") {
    throw new Error(`task ${index + 1} cannot use worktree isolation with read access`)
  }
  return { name, task, access, isolation, thinking: thinkingFrom(value.thinking, index) }
}

export function tasksFrom(args: Record<string, unknown>): TaskItem[] {
  if (!Array.isArray(args.tasks) || args.tasks.length === 0) throw new Error("tasks must contain at least one task")
  if (args.tasks.length > MAX_BATCH_TASKS) throw new Error(`tasks may contain at most ${MAX_BATCH_TASKS} tasks`)
  const tasks = args.tasks.map(taskFrom)
  const names = tasks.flatMap((task) => (task.name ? [task.name.toLowerCase()] : []))
  if (new Set(names).size !== names.length) throw new Error("task names must be unique within a batch")
  return tasks
}
