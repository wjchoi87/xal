import { expect, test } from "bun:test"
import { displayWidth, terminalGlyph } from "../lib/text"
import type { BackgroundBlock } from "./blocks"
import { backgroundResultHeading } from "./render"

const completed: BackgroundBlock = {
  kind: "background",
  id: "sleeper2",
  label: 'Wait for 3 seconds, then report: "sleeper 2 is back". Do not inspect or modify files.',
  status: "completed",
  output: "sleeper 2 is back\nFull task record: /tmp/sleeper2.md",
}

test("background results use the first report line in normal mode", () => {
  expect(backgroundResultHeading(completed, false, "Ctrl+O", 100)).toBe(
    `${terminalGlyph("↳", ">")} sleeper2 · sleeper 2 is back · Ctrl+O to read it`,
  )
})

test("background results move assignment metadata into expanded mode", () => {
  const heading = backgroundResultHeading(completed, true, "Ctrl+O", 100)

  expect(heading).toContain(completed.label)
  expect(heading).toContain("completed · 2 lines")
  expect(heading).not.toContain("Ctrl+O")
})

test("normal background results keep failures visible and stay on one row", () => {
  const failed: BackgroundBlock = { ...completed, status: "failed", output: "connection lost while waiting" }
  const heading = backgroundResultHeading(failed, false, "Ctrl+O", 48)
  const narrow = backgroundResultHeading(failed, false, "Ctrl+O", 30)
  const longId = backgroundResultHeading({ ...failed, id: "agent-with-a-very-long-identifier" }, false, "Ctrl+O", 48)

  expect(heading).toContain("sleeper2 · failed")
  expect(heading).toContain("Ctrl+O to read it")
  expect(narrow).toContain("sleeper2 · failed")
  expect(longId).toEndWith(" · failed")
  expect([heading, narrow, longId].every((value) => displayWidth(value) <= 48)).toBe(true)
  expect(displayWidth(narrow)).toBeLessThanOrEqual(30)
})
