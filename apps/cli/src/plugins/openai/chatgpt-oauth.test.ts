import { describe, expect, test } from "bun:test"
import { parseTokenResponse } from "./chatgpt-oauth"

describe("ChatGPT token responses", () => {
  test("requires an access token and defaults the expiry", () => {
    expect(() => parseTokenResponse({ expires_in: 3600 })).toThrow("token response missing access_token")
    expect(parseTokenResponse({ access_token: "token" })).toEqual({
      accessToken: "token",
      refreshToken: undefined,
      expiresInSeconds: 3600,
    })
    expect(parseTokenResponse({ access_token: "token", refresh_token: "refresh", expires_in: 3600 })).toEqual({
      accessToken: "token",
      refreshToken: "refresh",
      expiresInSeconds: 3600,
    })
  })
})
