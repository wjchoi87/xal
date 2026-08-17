import { expect, test } from "bun:test"
import { contextFrom, MAX_BATCH_TASKS, MAX_CONTEXT_LENGTH, MAX_TASK_LENGTH, tasksFrom } from "./parse"

test("accepts a batch and defaults isolation to the shared workspace", () => {
  const tasks = tasksFrom({
    tasks: [
      { task: "  audit the router  ", access: "read" },
      { name: "Fix-1", task: "fix the bug", access: "write", isolation: "worktree", thinking: "high" },
    ],
  })

  expect(tasks).toEqual([
    { name: undefined, task: "audit the router", access: "read", isolation: "shared", thinking: undefined },
    { name: "Fix-1", task: "fix the bug", access: "write", isolation: "worktree", thinking: "high" },
  ])
})

test("refuses a read-only task that asks for an isolated worktree", () => {
  expect(() => tasksFrom({ tasks: [{ task: "look around", access: "read", isolation: "worktree" }] })).toThrow(
    "task 1 cannot use worktree isolation with read access",
  )
})

test("refuses duplicate task names within a batch regardless of case", () => {
  expect(() =>
    tasksFrom({
      tasks: [
        { name: "review", task: "a", access: "read" },
        { name: "Review", task: "b", access: "read" },
      ],
    }),
  ).toThrow("task names must be unique within a batch")
})

test("rejects batches that are empty, oversized, or malformed", () => {
  expect(() => tasksFrom({})).toThrow("tasks must contain at least one task")
  expect(() => tasksFrom({ tasks: [] })).toThrow("tasks must contain at least one task")
  expect(() =>
    tasksFrom({ tasks: Array.from({ length: MAX_BATCH_TASKS + 1 }, () => ({ task: "go", access: "read" })) }),
  ).toThrow(`tasks may contain at most ${MAX_BATCH_TASKS} tasks`)
  expect(() => tasksFrom({ tasks: ["go"] })).toThrow("task 1 must be an object")
  expect(() => tasksFrom({ tasks: [{ task: "   ", access: "read" }] })).toThrow("task 1 is missing task instructions")
  expect(() => tasksFrom({ tasks: [{ task: "a".repeat(MAX_TASK_LENGTH + 1), access: "read" }] })).toThrow(
    `task 1 must be at most ${MAX_TASK_LENGTH} characters`,
  )
})

test("rejects task fields the spawner cannot act on", () => {
  expect(() => tasksFrom({ tasks: [{ task: "go", access: "admin" }] })).toThrow(
    'task 1 access must be "read" or "write"',
  )
  expect(() => tasksFrom({ tasks: [{ task: "go", access: "read", isolation: "container" }] })).toThrow(
    'task 1 isolation must be "shared" or "worktree"',
  )
  expect(() => tasksFrom({ tasks: [{ task: "go", access: "read", thinking: "extreme" }] })).toThrow(
    "task 1 thinking must be one of",
  )
  expect(() => tasksFrom({ tasks: [{ name: "1bad", task: "go", access: "read" }] })).toThrow(
    "task 1 name must start with a letter",
  )
  expect(() => tasksFrom({ tasks: [{ name: "a".repeat(33), task: "go", access: "read" }] })).toThrow(
    "task 1 name must start with a letter",
  )
})

test("reports the position of the offending task in a batch", () => {
  expect(() =>
    tasksFrom({
      tasks: [
        { task: "fine", access: "read" },
        { task: "fine", access: "read" },
        { task: "broken", access: "sideways" },
      ],
    }),
  ).toThrow("task 3 access")
})

test("requires trimmed shared context within the length budget", () => {
  expect(contextFrom({ context: "  shared background  " })).toBe("shared background")
  expect(() => contextFrom({})).toThrow("context is required")
  expect(() => contextFrom({ context: "   " })).toThrow("context is required")
  expect(() => contextFrom({ context: "a".repeat(MAX_CONTEXT_LENGTH + 1) })).toThrow(
    `context must be at most ${MAX_CONTEXT_LENGTH} characters`,
  )
})
