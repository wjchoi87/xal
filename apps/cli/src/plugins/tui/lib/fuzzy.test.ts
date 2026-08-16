import { describe, expect, test } from "bun:test"
import { fuzzyScore } from "./fuzzy"

const models = [
  { label: "gpt-5", detail: "openai · 400k · think" },
  { label: "gpt-5-codex", detail: "openai · 400k · think" },
  { label: "gpt-4o-mini", detail: "openai · 128k · img" },
  { label: "deepseek-chat-v3.2", detail: "deepseek · 128k · think" },
  { label: "gemini-2.5-pro", detail: "google · 1000k · img · think" },
]

function ranked(query: string): string[] {
  return models
    .flatMap((model, index) => {
      const score = fuzzyScore(query, [
        { text: model.label, weight: 1 },
        { text: model.detail, weight: 0.4 },
      ])
      return score === undefined ? [] : [{ label: model.label, score, index }]
    })
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map((match) => match.label)
}

describe("fuzzyScore", () => {
  test("ignores separators in query and candidate", () => {
    expect(ranked("gpt5")).toEqual(["gpt-5", "gpt-5-codex"])
    expect(ranked("gpt 5")).toEqual(["gpt-5", "gpt-5-codex"])
    expect(ranked("gpt-5")).toEqual(["gpt-5", "gpt-5-codex"])
  })

  test("ranks the tightest and shortest match first", () => {
    expect(ranked("codex")[0]).toBe("gpt-5-codex")
    expect(ranked("chatv32")[0]).toBe("deepseek-chat-v3.2")
    expect(ranked("25pro")[0]).toBe("gemini-2.5-pro")
  })

  test("matches each term against any field", () => {
    expect(ranked("deepseek chat")).toEqual(["deepseek-chat-v3.2"])
    expect(ranked("google think")).toEqual(["gemini-2.5-pro"])
  })

  test("rejects terms that only match as a scattered subsequence", () => {
    expect(ranked("gpt5")).not.toContain("gemini-2.5-pro")
    expect(fuzzyScore("gemini", [{ text: "gpt-5-codex", weight: 1 }])).toBeUndefined()
  })

  test("scores an empty query as a tie", () => {
    expect(fuzzyScore("  ", [{ text: "gpt-5", weight: 1 }])).toBe(0)
  })
})
