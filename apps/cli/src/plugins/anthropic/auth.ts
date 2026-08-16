import { appInfo } from "../../app-info"
import { loadCredential, saveCredential, type OAuthCredential } from "../../config/credentials"
import { asNumber, asString, isRecord } from "../../lib/json"
import type { ConnectContext } from "../../providers/types"
import { protectSecretValue } from "../../secrets/redactor"

export const PROVIDER_ID = "anthropic"

const AUTHORIZE_URL = "https://claude.ai/oauth/authorize"
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token"
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
const REDIRECT_PORT = 53692
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/callback`
const SCOPES =
  "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload"
const LOGIN_TIMEOUT_MS = 5 * 60 * 1_000
const REQUEST_TIMEOUT_MS = 30_000

const AUTH_METHODS = [
  {
    id: "api_key",
    label: "Anthropic API key",
    detail: "use metered Anthropic API billing",
  },
  {
    id: "browser",
    label: "Claude Pro/Max (browser)",
    detail: "open a local browser and receive the callback automatically",
  },
  {
    id: "paste",
    label: "Claude Pro/Max (paste callback)",
    detail: "authorize in another browser, then paste its localhost redirect URL",
  },
] as const

type AuthMethod = (typeof AUTH_METHODS)[number]["id"]

export type AnthropicAuth = { type: "api_key"; key: string } | { type: "oauth"; access: string }

interface TokenResponse {
  access: string
  refresh: string
  expiresInSeconds: number
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

function buildAuthorizeUrl(challenge: string, state: string): string {
  const url = new URL(AUTHORIZE_URL)
  url.searchParams.set("code", "true")
  url.searchParams.set("client_id", CLIENT_ID)
  url.searchParams.set("response_type", "code")
  url.searchParams.set("redirect_uri", REDIRECT_URI)
  url.searchParams.set("scope", SCOPES)
  url.searchParams.set("code_challenge", challenge)
  url.searchParams.set("code_challenge_method", "S256")
  url.searchParams.set("state", state)
  return url.toString()
}

function parsePastedCode(pasted: string, expectedState: string): { code: string; state: string } {
  const value = pasted.trim()
  if (!value) throw new Error("nothing was pasted")

  try {
    const url = new URL(value)
    const error = url.searchParams.get("error_description") ?? url.searchParams.get("error")
    if (error) throw new Error(`login failed: ${error}`)
    const code = url.searchParams.get("code")
    const state = url.searchParams.get("state")
    if (!code) throw new Error("no code found in the pasted URL")
    if (state && state !== expectedState) throw new Error("login failed: state mismatch")
    return { code, state: state ?? expectedState }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("login failed:")) throw error
    if (error instanceof Error && error.message === "no code found in the pasted URL") throw error
  }

  if (value.includes("code=")) {
    const params = new URLSearchParams(value)
    const code = params.get("code")
    const state = params.get("state")
    if (!code) throw new Error("no code found in the pasted value")
    if (state && state !== expectedState) throw new Error("login failed: state mismatch")
    return { code, state: state ?? expectedState }
  }

  const [code, state] = value.split("#", 2)
  if (!code) throw new Error("no authorization code was pasted")
  if (state && state !== expectedState) throw new Error("login failed: state mismatch")
  return { code, state: state ?? expectedState }
}

function startCallbackServer(state: string): { code: Promise<{ code: string; state: string }>; close: () => void } {
  let settled = false
  let resolveCode!: (result: { code: string; state: string }) => void
  let rejectCode!: (error: Error) => void
  const code = new Promise<{ code: string; state: string }>((resolve, reject) => {
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
        if (url.pathname !== "/callback") return new Response("not found", { status: 404 })
        if (url.searchParams.get("state") !== state) return new Response("invalid OAuth state", { status: 400 })
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
        resolveCode({ code: authCode, state })
        return htmlResponse(`Signed in to ${appInfo.name}. You can close this tab and return to the terminal.`)
      },
    })
  } catch {
    throw new Error(
      `could not listen on port ${REDIRECT_PORT}; choose “Claude Pro/Max (paste callback)” or free the port and try again`,
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

function parseTokenResponse(raw: unknown): TokenResponse {
  if (!isRecord(raw)) throw new Error("Anthropic token response was not an object")
  const access = asString(raw.access_token)
  const refresh = asString(raw.refresh_token)
  const expiresInSeconds = asNumber(raw.expires_in)
  if (!access || !refresh || expiresInSeconds === undefined || expiresInSeconds <= 0) {
    throw new Error("Anthropic token response was incomplete")
  }
  return { access, refresh, expiresInSeconds }
}

async function requestTokens(body: Record<string, string>): Promise<TokenResponse> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`Anthropic token request failed (${response.status}): ${text.slice(0, 300)}`)
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error("Anthropic token response was not valid JSON")
  }
  return parseTokenResponse(raw)
}

function toCredential(tokens: TokenResponse): OAuthCredential {
  return {
    type: "oauth",
    access: tokens.access,
    refresh: tokens.refresh,
    expires: Date.now() + tokens.expiresInSeconds * 1_000,
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
    if (current?.type !== "oauth" || current.access !== source.access || current.refresh !== source.refresh) {
      throw new Error("Anthropic credentials changed while refreshing; retry the request")
    }
    const next = toCredential(tokens)
    await saveCredential(PROVIDER_ID, next)
    return next
  })
}

async function selectMethod(ctx: ConnectContext): Promise<AuthMethod | undefined> {
  const index = await ctx.select(AUTH_METHODS.map(({ label, detail }) => ({ label, detail })))
  if (index === undefined) return undefined
  const method = AUTH_METHODS[index]
  if (!method) throw new Error("invalid authentication method selected")
  return method.id
}

async function connectApiKey(ctx: ConnectContext): Promise<boolean> {
  if (!ctx.askSecret) throw new Error("this interface cannot securely enter an Anthropic API key")
  const entered = await ctx.askSecret("Anthropic API key")
  if (entered === undefined) return false
  const key = entered.trim()
  if (!key) throw new Error("Anthropic API key cannot be empty")
  await saveCredential(PROVIDER_ID, { type: "api_key", key })
  ctx.print("connected to Anthropic with an API key")
  return true
}

async function browserCode(
  ctx: ConnectContext,
  authorizeUrl: string,
  state: string,
): Promise<{ code: string; state: string }> {
  const callback = startCallbackServer(state)
  ctx.print("opening your browser to sign in with Claude…")
  ctx.print(`if it doesn't open, visit: ${authorizeUrl}`)
  openBrowser(authorizeUrl)
  try {
    return await callback.code
  } finally {
    callback.close()
  }
}

async function pastedCode(
  ctx: ConnectContext,
  authorizeUrl: string,
  state: string,
): Promise<{ code: string; state: string } | undefined> {
  if (!ctx.askSecret) throw new Error("this interface cannot enter an OAuth callback")
  ctx.print(`open this URL in your browser: ${authorizeUrl}`)
  const pasted = await ctx.askSecret("Paste the final redirect URL or authorization code")
  if (pasted === undefined) return undefined
  return parsePastedCode(pasted, state)
}

async function connectSubscription(ctx: ConnectContext, method: "browser" | "paste"): Promise<boolean> {
  const { verifier, challenge } = await createPkce()
  const authorizeUrl = buildAuthorizeUrl(challenge, verifier)
  const result =
    method === "browser"
      ? await browserCode(ctx, authorizeUrl, verifier)
      : await pastedCode(ctx, authorizeUrl, verifier)
  if (!result) return false
  protectSecretValue(result.code)
  const tokens = await requestTokens({
    grant_type: "authorization_code",
    client_id: CLIENT_ID,
    code: result.code,
    state: result.state,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
  })
  await serializeCredentialWrite(() => saveCredential(PROVIDER_ID, toCredential(tokens)))
  ctx.print("connected to Claude Pro/Max")
  return true
}

export async function connect(ctx: ConnectContext): Promise<boolean> {
  const method = await selectMethod(ctx)
  if (!method) return false
  if (method === "api_key") return connectApiKey(ctx)
  return connectSubscription(ctx, method)
}

export async function isLoggedIn(): Promise<boolean> {
  return (await loadCredential(PROVIDER_ID)) !== undefined
}

export async function ensureAuth(forceRefresh = false): Promise<AnthropicAuth> {
  const credential = await loadCredential(PROVIDER_ID)
  if (!credential) throw new Error(`not connected to Anthropic; run: ${appInfo.name} connect claude`)
  if (credential.type === "api_key") return { type: "api_key", key: credential.key }
  if (!forceRefresh && credential.expires - 5 * 60_000 > Date.now()) {
    return { type: "oauth", access: credential.access }
  }

  let refresh = refreshPromises.get(credential.refresh)
  if (!refresh) {
    refresh = requestTokens({
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      refresh_token: credential.refresh,
    })
      .then((tokens) => saveRefreshedCredential(tokens, credential))
      .finally(() => {
        refreshPromises.delete(credential.refresh)
      })
    refreshPromises.set(credential.refresh, refresh)
  }
  const next = await refresh
  return { type: "oauth", access: next.access }
}
