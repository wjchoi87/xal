import { expect, mock, test } from "bun:test"

mock.module("../../lib/fs", () => ({
  async readJsonFile(): Promise<unknown> {
    return {
      models: [
        {
          id: "gpt-5.6-sol",
          name: "GPT-5.6-Sol",
          contextWindow: 272_000,
          inputModalities: ["text", "image"],
          thinking: { options: ["low", "medium", "high", "xhigh", "max"], default: "low" },
          supportsFast: true,
        },
      ],
    }
  },
  async writeSecureJson(): Promise<void> {},
}))

mock.module("./chatgpt-client", () => ({
  async chatGptFetch(): Promise<Response> {
    throw new Error("model discovery was not expected")
  },
}))

mock.module("./chatgpt-oauth", () => ({ PROVIDER_NAME: "ChatGPT" }))

const { listModels } = await import("./chatgpt-models")

test("adds regular and fast 1M Sol models to the ChatGPT catalog", async () => {
  const models = (await listModels("profile-1", false)).models

  expect(models.map((model) => model.id)).toEqual([
    "gpt-5.6-sol",
    "gpt-5.6-sol-fast",
    "gpt-5.6-sol-1m",
    "gpt-5.6-sol-1m-fast",
  ])
  expect(models[2]).toMatchObject({ contextWindow: 1_000_000, autoCompactTokenLimit: 900_000 })
  expect(models[3]).toMatchObject({ contextWindow: 1_000_000, autoCompactTokenLimit: 900_000 })
})
