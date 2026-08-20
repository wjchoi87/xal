import { describe, expect, test } from "bun:test"
import { miniMaxCodingPlanProvider, miniMaxProvider } from "./provider"

describe("MiniMax providers", () => {
  test("registers standard API and Coding Plan as separate providers", () => {
    expect(miniMaxProvider.id).toBe("minimax")
    expect(miniMaxProvider.name).toBe("MiniMax (minimax.io)")
    expect(miniMaxCodingPlanProvider.id).toBe("minimax-coding-plan")
    expect(miniMaxCodingPlanProvider.name).toBe("MiniMax Coding Plan (minimax.io)")
  })

  test("shares the minimax.io model catalog", async () => {
    const standard = await miniMaxProvider.listModels("standard-profile", false)
    const codingPlan = await miniMaxCodingPlanProvider.listModels("plan-profile", false)

    expect(codingPlan).toEqual(standard)
    expect(standard.source).toBe("bundled")
    expect(standard.models.find((model) => model.id === "MiniMax-M3")).toMatchObject({
      contextWindow: 1_000_000,
      inputModalities: ["text", "image"],
      thinking: { options: ["none", "high"], default: "high" },
    })
    const m27 = standard.models.find((model) => model.id === "MiniMax-M2.7")
    expect(m27).toMatchObject({ contextWindow: 204_800, inputModalities: ["text"] })
    expect(m27?.thinking).toBeUndefined()
  })
})
