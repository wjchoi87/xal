import { appInfo } from "../../app-info"
import { loadCredential, saveCredential, type OAuthCredential } from "../../config/credentials"
import { asString, isRecord } from "../../lib/json"
import { parseTokenResponse, type TokenResponse } from "./wire"

export const PROVIDER_ID = "openai-chatgpt"

const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize"
const TOKEN_URL = "https://auth.openai.com/oauth/token"
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
const REDIRECT_PORT = 1455
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/auth/callback`
const SCOPE = "openid profile email offline_access"
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000

export class NotLoggedInError extends Error {
  constructor() {
    super(`not logged in — run: ${appInfo.name} login chatgpt`)
  }
}

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

function extractAccountId(accessToken: string): string | undefined {
  const payload = decodeJwtPayload(accessToken)
  const auth = payload?.["https://api.openai.com/auth"]
  if (!isRecord(auth)) return undefined
  const accountId = asString(auth.chatgpt_account_id)
  return accountId || undefined
}

async function requestTokens(body: URLSearchParams): Promise<TokenResponse> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  })
  if (!response.ok) {
    const text = await response.text().catch(() => "")
    throw new Error(`token request failed (${response.status}): ${text.slice(0, 300)}`)
  }
  return parseTokenResponse(await response.json())
}

function toCredential(tokens: TokenResponse, previousRefresh?: string): OAuthCredential {
  const accountId = extractAccountId(tokens.accessToken)
  if (!accountId) {
    throw new Error("login succeeded but the token carries no ChatGPT account id — is this account on a ChatGPT plan?")
  }
  const refresh = tokens.refreshToken ?? previousRefresh
  if (!refresh) throw new Error("token response carried no refresh token")
  return {
    type: "oauth",
    access: tokens.accessToken,
    refresh,
    expires: Date.now() + tokens.expiresInSeconds * 1000,
    accountId,
  }
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
  url.searchParams.set("originator", appInfo.name)
  return url.toString()
}

function openBrowser(url: string): void {
  const command =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url]
  try {
    Bun.spawn(command, { stdout: "ignore", stderr: "ignore" })
  } catch {}
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
  if (trimmed.includes("code=")) {
    const url = new URL(trimmed)
    const error = url.searchParams.get("error")
    if (error) throw new Error(`login failed: ${error}`)
    const state = url.searchParams.get("state")
    if (state && state !== expectedState) throw new Error("login failed: state mismatch")
    const code = url.searchParams.get("code")
    if (!code) throw new Error("no code found in the pasted URL")
    return code
  }
  if (trimmed.includes("#")) return trimmed.split("#")[0]!
  return trimmed
}

function tryStartCallbackServer(state: string): { code: Promise<string>; close: () => void } | undefined {
  let settled = false
  let resolveCode!: (code: string) => void
  let rejectCode!: (error: Error) => void
  const code = new Promise<string>((resolve, reject) => {
    resolveCode = (value) => {
      if (!settled) {
        settled = true
        resolve(value)
      }
    }
    rejectCode = (error) => {
      if (!settled) {
        settled = true
        reject(error)
      }
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
        const error = url.searchParams.get("error")
        if (error) {
          rejectCode(new Error(`login failed: ${error}`))
          return htmlResponse("Login failed. You can close this tab.")
        }
        if (url.searchParams.get("state") !== state) {
          rejectCode(new Error("login failed: state mismatch"))
          return htmlResponse("Login failed (state mismatch). You can close this tab.")
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
    return undefined
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

export async function login(print: (line: string) => void): Promise<void> {
  const { verifier, challenge } = await createPkce()
  const state = base64url(crypto.getRandomValues(new Uint8Array(16)))
  const authorizeUrl = buildAuthorizeUrl(challenge, state)

  const callback = tryStartCallbackServer(state)
  print("opening your browser to sign in with ChatGPT…")
  print("if it doesn't open, visit:")
  print(`  ${authorizeUrl}`)
  openBrowser(authorizeUrl)

  let code: string
  if (callback) {
    try {
      code = await callback.code
    } finally {
      callback.close()
    }
  } else {
    print("")
    print("could not listen on port 1455 — after authorizing, copy the URL you were redirected to and paste it here.")
    const pasted = prompt("paste redirect URL or code:") ?? ""
    code = parsePastedCode(pasted, state)
  }

  const tokens = await requestTokens(
    new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI,
    }),
  )
  const credential = toCredential(tokens)
  await saveCredential(PROVIDER_ID, credential)
  print(`signed in (account ${credential.accountId})`)
}

export async function isLoggedIn(): Promise<boolean> {
  return (await loadCredential(PROVIDER_ID)) !== undefined
}

export async function ensureAccessToken(forceRefresh = false): Promise<{ access: string; accountId: string }> {
  const credential = await loadCredential(PROVIDER_ID)
  if (!credential) throw new NotLoggedInError()
  if (!forceRefresh && credential.expires - 60_000 > Date.now()) {
    return { access: credential.access, accountId: credential.accountId }
  }
  const tokens = await requestTokens(
    new URLSearchParams({
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      refresh_token: credential.refresh,
    }),
  )
  const next = toCredential(tokens, credential.refresh)
  await saveCredential(PROVIDER_ID, next)
  return { access: next.access, accountId: next.accountId }
}
