import { expect, test } from "bun:test"
import { taskListCompleted, type TrackedTask } from "./types"

test("a task list is complete only when it has tasks and every task is completed", () => {
  const completed: TrackedTask = { step: "Done", status: "completed" }

  expect(taskListCompleted([])).toBe(false)
  expect(taskListCompleted([completed])).toBe(true)
  expect(taskListCompleted([completed, { step: "Next", status: "pending" }])).toBe(false)
  expect(taskListCompleted([completed, { step: "Active", status: "in_progress" }])).toBe(false)
})
