import { expect, test } from "bun:test"
import { renderMarkdown } from "./render"

test("blockquotes do not add copied border characters", () => {
  const rendered = renderMarkdown("> quoted text", 80)

  expect(rendered.content.chunks.map((chunk) => chunk.text).join("")).toBe("quoted text")
})
