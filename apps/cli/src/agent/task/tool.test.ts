import { expect, test } from "bun:test"
import { compactTaskToolTitle } from "./tool"

test("task dispatch titles hide assignment previews in normal mode", () => {
  expect(compactTaskToolTitle("Dispatch 3 tasks · sleeper1: wait; sleeper2: wait; +1 more")).toBe("Dispatch 3 tasks")
  expect(compactTaskToolTitle("Dispatch tasks")).toBe("Dispatch tasks")
})
