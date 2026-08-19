import { expect, test } from "bun:test"
import { MAX_STALE_REMINDERS, MISSING_LIST_CALLS, STALE_LIST_CALLS, TaskReminders } from "./reminders"
import type { TrackedTask } from "./types"

const open: TrackedTask[] = [
  { step: "Wire reminders", status: "in_progress" },
  { step: "Update docs", status: "pending" },
]

function record(reminders: TaskReminders, calls: number): void {
  for (let index = 0; index < calls; index++) reminders.recordToolCall()
}

test("nudges once per turn to create a missing list after enough tool calls", () => {
  const reminders = new TaskReminders()
  record(reminders, MISSING_LIST_CALLS - 1)
  expect(reminders.take([])).toBeUndefined()
  reminders.recordToolCall()
  expect(reminders.take([])).toContain("without an active task list")
  record(reminders, MISSING_LIST_CALLS)
  expect(reminders.take([])).toBeUndefined()
  reminders.startTurn()
  record(reminders, MISSING_LIST_CALLS)
  expect(reminders.take([])).toContain("without an active task list")
})

test("leaves a fully completed list alone", () => {
  const reminders = new TaskReminders()
  record(reminders, MISSING_LIST_CALLS)
  expect(reminders.take([{ step: "Done", status: "completed" }])).toBeUndefined()
})

test("a new turn restores the stale reminder budget", () => {
  const reminders = new TaskReminders()
  for (let sent = 0; sent < MAX_STALE_REMINDERS; sent++) {
    record(reminders, STALE_LIST_CALLS)
    expect(reminders.take(open)).toContain("open steps")
  }
  reminders.startTurn()
  record(reminders, STALE_LIST_CALLS)
  expect(reminders.take(open)).toContain("open steps")
})

test("nudges a stale list a bounded number of times per turn", () => {
  const reminders = new TaskReminders()
  record(reminders, STALE_LIST_CALLS - 1)
  expect(reminders.take(open)).toBeUndefined()
  reminders.recordToolCall()
  expect(reminders.take(open)).toContain("2 open steps")
  for (let sent = 1; sent < MAX_STALE_REMINDERS; sent++) {
    record(reminders, STALE_LIST_CALLS)
    expect(reminders.take(open)).toContain("2 open steps")
  }
  record(reminders, STALE_LIST_CALLS)
  expect(reminders.take(open)).toBeUndefined()
})

test("a task list update resets the staleness counter", () => {
  const reminders = new TaskReminders()
  record(reminders, STALE_LIST_CALLS - 1)
  reminders.recordUpdate()
  reminders.recordToolCall()
  expect(reminders.take(open)).toBeUndefined()
})
