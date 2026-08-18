import { expect, test } from "bun:test"
import type { ModelInfo } from "../../providers/types"
import { resolveLargeContextModel, withLargeContextVariant } from "./model-variants"

const sol: ModelInfo = {
  id: "gpt-5.6-sol",
  name: "GPT-5.6-Sol",
  contextWindow: 260_000,
  inputModalities: ["text", "image"],
  thinking: { options: ["low", "medium", "high", "xhigh", "max"], default: "low" },
}

test("adds a 1M Sol picker model with a 900k compaction limit", () => {
  expect(withLargeContextVariant([sol])).toEqual([
    sol,
    {
      ...sol,
      id: "gpt-5.6-sol-1m",
      name: "GPT-5.6-Sol - 1M context",
      contextWindow: 1_000_000,
      autoCompactTokenLimit: 900_000,
    },
  ])
})

test("maps only the synthetic 1M model back to Sol on the wire", () => {
  expect(resolveLargeContextModel("gpt-5.6-sol-1m")).toBe("gpt-5.6-sol")
  expect(resolveLargeContextModel("another-model-1m")).toBe("another-model-1m")
})
