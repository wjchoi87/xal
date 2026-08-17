import { setTimeout as sleep } from "node:timers/promises"
import { appInfo } from "../../app-info"
import { loadCredential, replaceCredential, type OAuthCredential } from "../../config/credentials"
import type { ConnectContext } from "../../providers/types"
import { protectSecretValue } from "../../secrets/redactor"
import { clientIdentity, PROVIDER_ID } from "./api"
import {
  parseDeviceAuthorization,
  parseDeviceToken,
  parseTokenResponse,
  tokenErrorDetail,
  type DeviceAuthorization,
  type TokenResponse,
} from "./wire"

const ISSUER = "https://auth.x.ai"
const DEVICE_CODE_URL = `${ISSUER}/oauth2/device/code`
const TOKEN_URL = `${ISSUER}/oauth2/token`
const CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828"
const SCOPE = "openid profile email offline_access grok-cli:access api:access"
const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code"
const REFRESH_SKEW_MS = 5 * 60 * 1000
const DEFAULT_LIFETIME_SECONDS = 3600
const DEFAULT_INTERVAL_SECONDS = 5
const MIN_INTERVAL_MS = 1_000
const SLOW_DOWN_INCREMENT_MS = 5_000
const REQUEST_TIMEOUT_MS = 30_000

interface FormResponse {
  ok: boolean
  status: number
  body: unknown
}

const refreshPromises = new Map<string, Promise<OAuthCredential>>()

async function postForm(url: string, fields: Record<string, string>, timeoutMs: number): Promise<FormResponse> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": clientIdentity().userAgent,
    },
    body: new URLSearchParams(fields),
    signal: AbortSignal.timeout(timeoutMs),
  })
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new Error(`xAI OAuth returned invalid JSON (${response.status})`)
  }
  return { ok: response.ok, status: response.status, body }
}

function credentialFrom(tokens: TokenResponse, previousRefresh?: string): OAuthCredential {
  const refresh = tokens.refresh ?? previousRefresh
  if (!refresh) throw new Error("xAI token response carried no refresh token")
  const lifetime = tokens.expiresInSeconds ?? DEFAULT_LIFETIME_SECONDS
  return {
    type: "oauth",
    access: tokens.access,
    refresh,
    expires: Date.now() + lifetime * 1_000 - REFRESH_SKEW_MS,
  }
}

async function requestDeviceAuthorization(): Promise<DeviceAuthorization> {
  const response = await postForm(
    DEVICE_CODE_URL,
    { client_id: CLIENT_ID, scope: SCOPE, referrer: clientIdentity().name },
    REQUEST_TIMEOUT_MS,
  )
  if (!response.ok) {
    const detail = tokenErrorDetail(response.body)
    throw new Error(`xAI device authorization failed (${response.status})${detail ? `: ${detail}` : ""}`)
  }
  return parseDeviceAuthorization(response.body)
}

async function pollForTokens(device: DeviceAuthorization): Promise<TokenResponse> {
  const deadline = Date.now() + device.expiresInSeconds * 1_000
  let intervalMs = Math.max(MIN_INTERVAL_MS, (device.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS) * 1_000)
  while (true) {
    const wait = Math.min(intervalMs, deadline - Date.now())
    if (wait <= 0) break
    await sleep(wait)
    const response = await postForm(
      TOKEN_URL,
      { grant_type: DEVICE_CODE_GRANT, client_id: CLIENT_ID, device_code: device.deviceCode },
      Math.max(1, Math.min(REQUEST_TIMEOUT_MS, deadline - Date.now())),
    )
    const result = parseDeviceToken(response.body, response.ok)
    switch (result.type) {
      case "complete":
        return result.tokens
      case "pending":
        break
      case "slow_down":
        intervalMs = Math.max(
          MIN_INTERVAL_MS,
          result.intervalSeconds ? result.intervalSeconds * 1_000 : intervalMs + SLOW_DOWN_INCREMENT_MS,
        )
        break
      case "failed":
        throw new Error(result.message)
    }
  }
  throw new Error("xAI device login timed out")
}

export async function login(ctx: ConnectContext): Promise<OAuthCredential> {
  const device = await requestDeviceAuthorization()
  ctx.print(`open ${device.verificationUri}`)
  ctx.print(`enter code: ${device.userCode}`)
  if (device.verificationUriComplete) {
    ctx.print("")
    ctx.print(`or open ${device.verificationUriComplete}`)
  }
  ctx.print("")
  ctx.print("waiting for xAI authorization…")
  const tokens = await pollForTokens(device)
  protectSecretValue(tokens.access)
  if (tokens.refresh) protectSecretValue(tokens.refresh)
  ctx.print("signed in with your Grok subscription")
  return credentialFrom(tokens)
}

async function refreshCredential(profileId: string, credential: OAuthCredential): Promise<OAuthCredential> {
  const response = await postForm(
    TOKEN_URL,
    { grant_type: "refresh_token", client_id: CLIENT_ID, refresh_token: credential.refresh },
    REQUEST_TIMEOUT_MS,
  )
  if (!response.ok) {
    const detail = tokenErrorDetail(response.body)
    throw new Error(`xAI token refresh failed (${response.status})${detail ? `: ${detail}` : ""}`)
  }
  const next = credentialFrom(parseTokenResponse(response.body), credential.refresh)
  await replaceCredential(PROVIDER_ID, profileId, credential, next)
  return next
}

export async function ensureAccessToken(profileId: string, forceRefresh = false): Promise<string> {
  const credential = await loadCredential(PROVIDER_ID, profileId)
  if (credential?.type !== "oauth") throw new Error(`not connected to xAI — run: ${appInfo.name} connect xai`)
  if (!forceRefresh && credential.expires > Date.now()) return credential.access

  let refresh = refreshPromises.get(profileId)
  if (!refresh) {
    refresh = refreshCredential(profileId, credential).finally(() => {
      refreshPromises.delete(profileId)
    })
    refreshPromises.set(profileId, refresh)
  }
  return (await refresh).access
}
