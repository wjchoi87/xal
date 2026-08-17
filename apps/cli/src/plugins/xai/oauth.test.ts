import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import type { Credential, OAuthCredential } from "../../config/credentials"

let stored: Credential | undefined
const replacements: { expected: Credential; credential: Credential }[] = []

mock.module("../../config/credentials", () => ({
  async loadCredential(): Promise<Credential | undefined> {
    return stored
  },
  async replaceCredential(_provider: string, _profile: string, expected: Credential, credential: Credential) {
    replacements.push({ expected, credential })
    stored = credential
  },
}))

const { ensureAccessToken } = await import("./oauth")

const originalFetch = globalThis.fetch
const forms: URLSearchParams[] = []
const replies: { body: unknown; status?: number }[] = []

function oauthCredential(overrides: Partial<OAuthCredential> = {}): OAuthCredential {
  return { type: "oauth", access: "old-access", refresh: "old-refresh", expires: 0, ...overrides }
}

beforeEach(() => {
  stored = undefined
  replacements.length = 0
  forms.length = 0
  replies.length = 0
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    expect(String(url)).toBe("https://auth.x.ai/oauth2/token")
    forms.push(new URLSearchParams(String(init?.body)))
    const reply = replies.shift()
    if (!reply) throw new Error("missing mocked xAI token response")
    return new Response(JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { "content-type": "application/json" },
    })
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("xAI OAuth access tokens", () => {
  test("reuses a stored token that has not reached its refresh deadline", async () => {
    stored = oauthCredential({ expires: Date.now() + 60_000 })
    expect(await ensureAccessToken("profile-1")).toBe("old-access")
    expect(forms).toHaveLength(0)
  })

  test("refreshes with the device client and persists the rotated pair", async () => {
    stored = oauthCredential()
    replies.push({ body: { access_token: "new-access", refresh_token: "new-refresh", expires_in: 21_600 } })

    expect(await ensureAccessToken("profile-1")).toBe("new-access")
    expect(Object.fromEntries(forms[0]!)).toEqual({
      grant_type: "refresh_token",
      client_id: "b1a00492-073a-47ea-816f-4c329264a828",
      refresh_token: "old-refresh",
    })
    expect(replacements[0]!.credential).toMatchObject({ type: "oauth", access: "new-access", refresh: "new-refresh" })
  })

  test("keeps the previous refresh token when xAI does not rotate it", async () => {
    stored = oauthCredential({ refresh: "keep-refresh" })
    replies.push({ body: { access_token: "newer-access", expires_in: 21_600 } })

    await ensureAccessToken("profile-1")
    expect(replacements[0]!.credential).toMatchObject({ access: "newer-access", refresh: "keep-refresh" })
  })

  test("applies the refresh skew and the default lifetime", async () => {
    stored = oauthCredential()
    replies.push({ body: { access_token: "new-access", refresh_token: "new-refresh" } })

    const before = Date.now()
    await ensureAccessToken("profile-1")
    const credential = replacements[0]!.credential

    if (credential.type !== "oauth") throw new Error("expected an oauth credential")
    expect(credential.expires).toBeGreaterThanOrEqual(before + 3_600_000 - 300_000)
    expect(credential.expires).toBeLessThanOrEqual(Date.now() + 3_600_000 - 300_000)
  })

  test("collapses concurrent refreshes onto one token request", async () => {
    stored = oauthCredential()
    replies.push({ body: { access_token: "new-access", refresh_token: "new-refresh", expires_in: 21_600 } })

    const tokens = await Promise.all([ensureAccessToken("profile-1"), ensureAccessToken("profile-1")])
    expect(tokens).toEqual(["new-access", "new-access"])
    expect(forms).toHaveLength(1)
  })

  test("surfaces the upstream error when the refresh token is rejected", async () => {
    stored = oauthCredential()
    replies.push({ body: { error: "invalid_grant", error_description: "refresh token revoked" }, status: 400 })

    await expect(ensureAccessToken("profile-1")).rejects.toThrow(
      "xAI token refresh failed (400): invalid_grant: refresh token revoked",
    )
  })

  test("refuses to stream when the profile is not connected with OAuth", async () => {
    stored = { type: "api_key", key: "xai-key" }
    await expect(ensureAccessToken("profile-1")).rejects.toThrow("not connected to xAI")
  })
})
