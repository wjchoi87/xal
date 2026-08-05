import { describe, expect, test } from "bun:test"
import { parseSseEvent } from "./wire"

describe("OpenAI response wire events", () => {
  test("keeps reasoning summaries separate from raw reasoning", () => {
    expect(
      parseSseEvent({
        type: "response.reasoning_summary_text.delta",
        delta: "Summarizing the plan",
      }),
    ).toEqual({ type: "reasoning_summary_delta", delta: "Summarizing the plan" })

    expect(
      parseSseEvent({
        type: "response.reasoning_text.delta",
        delta: "Raw reasoning",
      }),
    ).toEqual({ type: "reasoning_delta", delta: "Raw reasoning" })
  })
})
