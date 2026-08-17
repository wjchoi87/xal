import { beforeEach, describe, expect, mock, test } from "bun:test"

const cached = new Map<string, unknown>()
const responses: (Response | Error)[] = []
const requests: { path: string; key: string }[] = []

mock.module("../../lib/fs", () => ({
  async readJsonFile(path: string): Promise<unknown> {
    return cached.get(path)
  },
  async writeSecureJson(path: string, value: unknown): Promise<void> {
    cached.set(path, value)
  },
}))

mock.module("./api-auth", () => ({
  async apiKey(): Promise<string> {
    return "sk-test"
  },
}))

mock.module("./api-client", () => ({
  async openAiFetch(path: string, key: string): Promise<Response> {
    requests.push({ path, key })
    const response = responses.shift()
    if (!response) throw new Error("missing mocked OpenAI response")
    if (response instanceof Error) throw response
    return response
  },
  async raiseForStatus(response: Response): Promise<never> {
    throw new Error(`OpenAI request failed (${response.status})`)
  },
}))

const { setContextWindowCap } = await import("./context-window")
const { defaultModel, listModels } = await import("./api-models")

function modelsResponse(ids: string[]): Response {
  return Response.json({ data: ids.map((id) => ({ id, object: "model", owned_by: "openai" })) })
}

beforeEach(() => {
  cached.clear()
  responses.length = 0
  requests.length = 0
  setContextWindowCap(undefined)
})

describe("OpenAI model catalog", () => {
  test("keeps Responses models and excludes non-agent model families", async () => {
    responses.push(
      modelsResponse([
        "gpt-5.2",
        "gpt-image-1",
        "gpt-4.1",
        "gpt-4o-realtime-preview",
        "gpt-3.5-turbo",
        "o3",
        "text-embedding-3-large",
        "codex-mini-latest",
      ]),
    )

    const catalog = await listModels("profile-1", true)

    expect(catalog.source).toBe("runtime")
    expect(catalog.models.map((model) => model.id)).toEqual(["gpt-5.2", "gpt-4.1", "o3", "codex-mini-latest"])
    expect(catalog.models[0]).toMatchObject({
      contextWindow: 260_000,
      inputModalities: ["text", "image"],
      thinking: { options: ["low", "medium", "high"], default: "medium" },
    })
    expect(catalog.models[1]?.thinking).toBeUndefined()
    expect(catalog.models[2]?.contextWindow).toBe(200_000)
    expect(catalog.models[3]).toMatchObject({ contextWindow: 200_000, inputModalities: ["text", "image"] })
    expect(requests).toEqual([{ path: "/models", key: "sk-test" }])
  })

  test("advertises model-specific reasoning ranges", async () => {
    responses.push(modelsResponse(["gpt-5.6", "gpt-5.5", "gpt-5.4", "gpt-5.4-pro"]))

    const models = (await listModels("profile-1", true)).models

    expect(models[0]?.thinking).toEqual({
      options: ["none", "low", "medium", "high", "xhigh", "max"],
      default: "medium",
    })
    expect(models[1]?.thinking).toEqual({
      options: ["none", "low", "medium", "high", "xhigh"],
      default: "medium",
    })
    expect(models[2]?.thinking).toEqual({
      options: ["none", "low", "medium", "high", "xhigh"],
      default: "none",
    })
    expect(models[3]?.thinking).toEqual({ options: ["medium", "high", "xhigh"], default: "medium" })
  })

  test("reuses the profile cache when live discovery fails", async () => {
    responses.push(modelsResponse(["gpt-5.2", "gpt-4.1"]))
    await listModels("profile-1", true)
    responses.push(new Error("offline"))

    const catalog = await listModels("profile-1", true)

    expect(catalog.source).toBe("cache")
    expect(catalog.warning).toContain("live discovery failed")
    expect(catalog.models.map((model) => model.id)).toEqual(["gpt-5.2", "gpt-4.1"])
  })

  test("keeps each profile's cached model catalog isolated", async () => {
    responses.push(modelsResponse(["gpt-5.6"]), modelsResponse(["gpt-4.1"]))
    await listModels("profile-1", true)
    await listModels("profile-2", true)
    requests.length = 0

    expect((await listModels("profile-1", false)).models.map((model) => model.id)).toEqual(["gpt-5.6"])
    expect((await listModels("profile-2", false)).models.map((model) => model.id)).toEqual(["gpt-4.1"])
    expect(requests).toHaveLength(0)
  })

  test("applies the configured context cap to cached models and uses the first model as the default", async () => {
    responses.push(modelsResponse(["gpt-5.2", "gpt-4.1"]))
    await listModels("profile-1", true)
    requests.length = 0
    setContextWindowCap(128_000)

    const catalog = await listModels("profile-1", false)

    expect(catalog.models.map((model) => model.contextWindow)).toEqual([128_000, 128_000])
    expect(await defaultModel("profile-1")).toBe("gpt-5.2")
    expect(requests).toHaveLength(0)
  })

  test("fails when discovery has no compatible Responses models and no cache", async () => {
    responses.push(modelsResponse(["whisper-1", "gpt-image-1", "text-embedding-3-small"]))

    await expect(listModels("profile-1", true)).rejects.toThrow(
      "OpenAI returned no models compatible with the Responses API",
    )
  })
})
