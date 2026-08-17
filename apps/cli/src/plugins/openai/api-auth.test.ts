import { beforeEach, describe, expect, mock, test } from "bun:test"
import type { Credential } from "../../config/credentials"

let stored: Credential | undefined
const requests: { path: string; key: string; init: RequestInit }[] = []
const responses: Response[] = []

mock.module("../../config/credentials", () => ({
  async loadCredential(): Promise<Credential | undefined> {
    return stored
  },
}))

mock.module("./api-client", () => ({
  PROVIDER_ID: "openai",
  async openAiFetch(path: string, key: string, init: RequestInit = {}): Promise<Response> {
    requests.push({ path, key, init })
    const response = responses.shift()
    if (!response) throw new Error("missing mocked OpenAI response")
    return response
  },
  async raiseForStatus(response: Response): Promise<never> {
    throw new Error(`OpenAI request failed (${response.status})`)
  },
}))

const { apiKey, connect } = await import("./api-auth")

beforeEach(() => {
  stored = undefined
  requests.length = 0
  responses.length = 0
})

describe("OpenAI API authentication", () => {
  test("validates and stores a trimmed API key", async () => {
    responses.push(Response.json({ data: [] }))
    const printed: string[] = []

    const credential = await connect({
      print(line) {
        printed.push(line)
      },
      async select() {
        return undefined
      },
      async askSecret() {
        return "  sk-test  "
      },
    })

    expect(credential).toEqual({ type: "api_key", key: "sk-test" })
    expect(printed).toEqual(["connected to OpenAI"])
    expect(requests).toHaveLength(1)
    expect(requests[0]!.path).toBe("/models")
    expect(requests[0]!.key).toBe("sk-test")
    expect(requests[0]!.init.signal).toBeInstanceOf(AbortSignal)
  })

  test("does not store a key rejected by OpenAI", async () => {
    responses.push(Response.json({ error: { message: "invalid key" } }, { status: 401 }))

    await expect(
      connect({
        print() {},
        async select() {
          return undefined
        },
        async askSecret() {
          return "sk-invalid"
        },
      }),
    ).rejects.toThrow("OpenAI request failed (401)")
  })

  test("loads only API-key credentials for OpenAI profiles", async () => {
    stored = { type: "api_key", key: "sk-stored" }
    expect(await apiKey("profile-1")).toBe("sk-stored")

    stored = { type: "oauth", access: "access", refresh: "refresh", expires: Date.now() + 60_000 }
    await expect(apiKey("profile-1")).rejects.toThrow("not connected to OpenAI")
  })
})
