import { setTimeout as sleep } from "node:timers/promises"
import { appInfo } from "../../app-info"
import { loadCredential, saveCredential, type OAuthCredential } from "../../config/credentials"
import { asNumber, asString, isRecord } from "../../lib/json"
import type { ConnectContext } from "../../providers/types"
import { protectSecretValue } from "../../secrets/redactor"
import { clientIdentity } from "./identity"
import { parseTokenResponse, type TokenResponse } from "./wire"

export const PROVIDER_ID = "openai-chatgpt"

const ISSUER = "https://auth.openai.com"
const AUTHORIZE_URL = `${ISSUER}/oauth/authorize`
const TOKEN_URL = `${ISSUER}/oauth/token`
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
const REDIRECT_PORT = 1455
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/auth/callback`
const DEVICE_REDIRECT_URI = `${ISSUER}/deviceauth/callback`
const SCOPE = "openid profile email offline_access"
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000
const DEVICE_LOGIN_TIMEOUT_MS = 15 * 60 * 1000
const REQUEST_TIMEOUT_MS = 30_000
const POLLING_SAFETY_MARGIN_MS = 3_000

const AUTH_METHODS = [
  {
    id: "browser",
    label: "ChatGPT Pro/Plus (browser)",
    detail: "open a local browser and receive the callback automatically",
  },
  {
    id: "paste",
    label: "ChatGPT Pro/Plus (paste callback)",
    detail: "authorize in another browser, then paste its localhost redirect URL",
  },
  {
    id: "headless",
    label: "ChatGPT Pro/Plus (headless)",
    detail: "enter a short code at auth.openai.com/codex/device",
  },
] as const

type AuthMethod = (typeof AUTH_METHODS)[number]["id"]

interface DeviceAuthorization {
  id: string
  userCode: string
  intervalMs: number
}

interface DeviceToken {
  code: string
  verifier: string
}

const refreshPromises = new Map<string, Promise<OAuthCredential>>()
let credentialWrite = Promise.resolve()

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
}

async function createPkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)))
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
  return { verifier, challenge: base64url(new Uint8Array(digest)) }
}

function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const payload = token.split(".")[1]
  if (!payload) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))
  } catch {
    return undefined
  }
  return isRecord(parsed) ? parsed : undefined
}

function accountIdFromToken(token: string | undefined): string | undefined {
  if (!token) return undefined
  const payload = decodeJwtPayload(token)
  const direct = asString(payload?.chatgpt_account_id)
  if (direct) return direct
  const auth = payload?.["https://api.openai.com/auth"]
  if (isRecord(auth)) {
    const accountId = asString(auth.chatgpt_account_id)
    if (accountId) return accountId
  }
  if (!Array.isArray(payload?.organizations)) return undefined
  const organization = payload.organizations.find(isRecord)
  return organization ? asString(organization.id) : undefined
}

async function requestTokens(body: URLSearchParams): Promise<TokenResponse> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": clientIdentity().userAgent,
    },
    body,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) {
    const text = await response.text().catch(() => "")
    throw new Error(`token request failed (${response.status}): ${text.slice(0, 300)}`)
  }
  return parseTokenResponse(await response.json())
}

function toCredential(tokens: TokenResponse, previous?: OAuthCredential): OAuthCredential {
  const accountId = accountIdFromToken(tokens.idToken) ?? accountIdFromToken(tokens.accessToken) ?? previous?.accountId
  if (!accountId) {
    throw new Error("login succeeded but the token carries no ChatGPT account id — is this account on a ChatGPT plan?")
  }
  const refresh = tokens.refreshToken ?? previous?.refresh
  if (!refresh) throw new Error("token response carried no refresh token")
  return {
    type: "oauth",
    access: tokens.accessToken,
    refresh,
    expires: Date.now() + tokens.expiresInSeconds * 1000,
    accountId,
  }
}

function serializeCredentialWrite<T>(write: () => Promise<T>): Promise<T> {
  const result = credentialWrite.then(write)
  credentialWrite = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}

async function saveRefreshedCredential(tokens: TokenResponse, source: OAuthCredential): Promise<OAuthCredential> {
  return serializeCredentialWrite(async () => {
    const current = await loadCredential(PROVIDER_ID)
    if (
      current?.type !== "oauth" ||
      current.access !== source.access ||
      current.refresh !== source.refresh ||
      current.accountId !== source.accountId
    ) {
      throw new Error("ChatGPT credentials changed while refreshing — retry the request")
    }
    const next = toCredential(tokens, current)
    await saveCredential(PROVIDER_ID, next)
    return next
  })
}

function buildAuthorizeUrl(challenge: string, state: string): string {
  const url = new URL(AUTHORIZE_URL)
  url.searchParams.set("response_type", "code")
  url.searchParams.set("client_id", CLIENT_ID)
  url.searchParams.set("redirect_uri", REDIRECT_URI)
  url.searchParams.set("scope", SCOPE)
  url.searchParams.set("code_challenge", challenge)
  url.searchParams.set("code_challenge_method", "S256")
  url.searchParams.set("state", state)
  url.searchParams.set("id_token_add_organizations", "true")
  url.searchParams.set("codex_cli_simplified_flow", "true")
  url.searchParams.set("originator", clientIdentity().name)
  return url.toString()
}

function openBrowser(url: string): boolean {
  const command =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url]
  try {
    Bun.spawn(command, { stdout: "ignore", stderr: "ignore" })
    return true
  } catch {
    return false
  }
}

function htmlResponse(message: string): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>${appInfo.name}</title><body style="font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0"><p>${message}</p></body>`,
    { headers: { "content-type": "text/html" } },
  )
}

function parsePastedCode(pasted: string, expectedState: string): string {
  const trimmed = pasted.trim()
  if (!trimmed) throw new Error("nothing was pasted")

  if (/^[a-z][a-z\d+.-]*:/i.test(trimmed)) {
    const url = new URL(trimmed)
    if (url.searchParams.get("state") !== expectedState) throw new Error("login failed: state mismatch")
    const error = url.searchParams.get("error_description") ?? url.searchParams.get("error")
    if (error) throw new Error(`login failed: ${error}`)
    const code = url.searchParams.get("code")
    if (!code) throw new Error("no code found in the pasted URL")
    return code
  }

  const [code, state] = trimmed.split("#", 2)
  if (state && state !== expectedState) throw new Error("login failed: state mismatch")
  if (!code) throw new Error("no authorization code was pasted")
  return code
}

function startCallbackServer(state: string): { code: Promise<string>; close: () => void } {
  let settled = false
  let resolveCode!: (code: string) => void
  let rejectCode!: (error: Error) => void
  const code = new Promise<string>((resolve, reject) => {
    resolveCode = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    rejectCode = (error) => {
      if (settled) return
      settled = true
      reject(error)
    }
  })

  let server: ReturnType<typeof Bun.serve>
  try {
    server = Bun.serve({
      port: REDIRECT_PORT,
      hostname: "127.0.0.1",
      fetch(request) {
        const url = new URL(request.url)
        if (url.pathname !== "/auth/callback") return new Response("not found", { status: 404 })
        if (url.searchParams.get("state") !== state) {
          return new Response("invalid OAuth state", { status: 400 })
        }
        const error = url.searchParams.get("error_description") ?? url.searchParams.get("error")
        if (error) {
          rejectCode(new Error(`login failed: ${error}`))
          return htmlResponse("Login failed. You can close this tab.")
        }
        const authCode = url.searchParams.get("code")
        if (!authCode) {
          rejectCode(new Error("login failed: no code in callback"))
          return htmlResponse("Login failed (missing code). You can close this tab.")
        }
        resolveCode(authCode)
        return htmlResponse(`Signed in to ${appInfo.name}. You can close this tab and return to the terminal.`)
      },
    })
  } catch {
    throw new Error(
      `could not listen on port ${REDIRECT_PORT} — choose “ChatGPT Pro/Plus (paste callback)” or free the port and try again`,
    )
  }

  const timeout = setTimeout(() => rejectCode(new Error("login timed out after 5 minutes")), LOGIN_TIMEOUT_MS)

  return {
    code,
    close() {
      clearTimeout(timeout)
      server.stop(true)
    },
  }
}

async function selectMethod(ctx: ConnectContext): Promise<AuthMethod | undefined> {
  const index = await ctx.select(AUTH_METHODS.map(({ label, detail }) => ({ label, detail })))
  if (index === undefined) return undefined
  const method = AUTH_METHODS[index]
  if (!method) throw new Error("invalid authentication method selected")
  return method.id
}

async function browserCode(ctx: ConnectContext, authorizeUrl: string, state: string): Promise<string> {
  const callback = startCallbackServer(state)
  ctx.print("opening your browser to sign in with ChatGPT…")
  ctx.print("if it doesn't open, visit:")
  ctx.print(`  ${authorizeUrl}`)
  if (!openBrowser(authorizeUrl)) ctx.print("could not open the browser automatically — open the link above")
  try {
    return await callback.code
  } finally {
    callback.close()
  }
}

async function pastedCode(ctx: ConnectContext, authorizeUrl: string, state: string): Promise<string | undefined> {
  if (!ctx.askSecret) throw new Error("this interface cannot accept a pasted redirect URL")
  ctx.print("open this link in a browser and complete authorization:")
  ctx.print(`  ${authorizeUrl}`)
  ctx.print("")
  ctx.print("when the browser redirects to localhost, copy its full address and paste it below")
  const pasted = await ctx.askSecret("redirect URL")
  if (pasted === undefined) return undefined
  return parsePastedCode(pasted, state)
}

async function requestDeviceAuthorization(): Promise<DeviceAuthorization> {
  const response = await fetch(`${ISSUER}/api/accounts/deviceauth/usercode`, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": clientIdentity().userAgent },
    body: JSON.stringify({ client_id: CLIENT_ID }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) {
    const text = await response.text().catch(() => "")
    throw new Error(`device authorization request failed (${response.status}): ${text.slice(0, 300)}`)
  }
  const raw: unknown = await response.json()
  if (!isRecord(raw)) throw new Error("device authorization response was not an object")
  const id = asString(raw.device_auth_id)
  const userCode = asString(raw.user_code)
  const interval = asString(raw.interval) ?? String(asNumber(raw.interval) ?? "")
  const intervalSeconds = Number.parseInt(interval, 10)
  if (!id || !userCode) throw new Error("device authorization response was incomplete")
  return {
    id,
    userCode,
    intervalMs: Math.max(Number.isFinite(intervalSeconds) ? intervalSeconds : 5, 1) * 1000,
  }
}

async function pollDeviceToken(device: DeviceAuthorization): Promise<DeviceToken> {
  const deadline = Date.now() + DEVICE_LOGIN_TIMEOUT_MS
  while (Date.now() < deadline) {
    let response: Response
    try {
      response = await fetch(`${ISSUER}/api/accounts/deviceauth/token`, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": clientIdentity().userAgent },
        body: JSON.stringify({ device_auth_id: device.id, user_code: device.userCode }),
        signal: AbortSignal.timeout(Math.max(1, Math.min(REQUEST_TIMEOUT_MS, deadline - Date.now()))),
      })
    } catch (error) {
      if (Date.now() >= deadline) throw new Error("device login timed out after 15 minutes", { cause: error })
      throw error
    }
    if (response.ok) {
      const raw: unknown = await response.json()
      if (!isRecord(raw)) throw new Error("device token response was not an object")
      const code = asString(raw.authorization_code)
      const verifier = asString(raw.code_verifier)
      if (!code || !verifier) throw new Error("device token response was incomplete")
      return { code, verifier }
    }
    if (response.status !== 403 && response.status !== 404) {
      const text = await response.text().catch(() => "")
      throw new Error(`device authorization failed (${response.status}): ${text.slice(0, 300)}`)
    }
    await sleep(Math.max(0, Math.min(device.intervalMs + POLLING_SAFETY_MARGIN_MS, deadline - Date.now())))
  }
  throw new Error("device login timed out after 15 minutes")
}

async function deviceTokens(ctx: ConnectContext): Promise<TokenResponse> {
  const device = await requestDeviceAuthorization()
  ctx.print(`${ISSUER}/codex/device`)
  ctx.print(`Enter code: ${device.userCode}`)
  ctx.print("")
  ctx.print("waiting for authorization…")
  const token = await pollDeviceToken(device)
  protectSecretValue(token.code)
  protectSecretValue(token.verifier)
  return requestTokens(
    new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code: token.code,
      code_verifier: token.verifier,
      redirect_uri: DEVICE_REDIRECT_URI,
    }),
  )
}

export async function login(ctx: ConnectContext): Promise<boolean> {
  const method = await selectMethod(ctx)
  if (!method) return false

  let tokens: TokenResponse
  if (method === "headless") {
    tokens = await deviceTokens(ctx)
  } else {
    const { verifier, challenge } = await createPkce()
    const state = base64url(crypto.getRandomValues(new Uint8Array(32)))
    const authorizeUrl = buildAuthorizeUrl(challenge, state)
    const code =
      method === "browser" ? await browserCode(ctx, authorizeUrl, state) : await pastedCode(ctx, authorizeUrl, state)
    if (code === undefined) return false
    protectSecretValue(code)
    tokens = await requestTokens(
      new URLSearchParams({
        grant_type: "authorization_code",
        client_id: CLIENT_ID,
        code,
        code_verifier: verifier,
        redirect_uri: REDIRECT_URI,
      }),
    )
  }

  const credential = toCredential(tokens)
  await serializeCredentialWrite(() => saveCredential(PROVIDER_ID, credential))
  ctx.print(`signed in (account ${credential.accountId})`)
  return true
}

export async function isLoggedIn(): Promise<boolean> {
  return (await loadCredential(PROVIDER_ID))?.type === "oauth"
}

export async function ensureAccessToken(forceRefresh = false): Promise<{ access: string; accountId: string }> {
  const credential = await loadCredential(PROVIDER_ID)
  if (credential?.type !== "oauth") throw new Error(`not logged in — run: ${appInfo.name} connect chatgpt`)
  if (!forceRefresh && credential.expires - 60_000 > Date.now()) {
    return { access: credential.access, accountId: credential.accountId }
  }
  let refresh = refreshPromises.get(credential.refresh)
  if (!refresh) {
    refresh = requestTokens(
      new URLSearchParams({
        grant_type: "refresh_token",
        client_id: CLIENT_ID,
        refresh_token: credential.refresh,
      }),
    )
      .then((tokens) => saveRefreshedCredential(tokens, credential))
      .finally(() => {
        refreshPromises.delete(credential.refresh)
      })
    refreshPromises.set(credential.refresh, refresh)
  }
  const next = await refresh
  return { access: next.access, accountId: next.accountId }
}
