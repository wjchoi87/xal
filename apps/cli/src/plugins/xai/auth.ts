import { appInfo } from "../../app-info"
import { loadCredential, type Credential } from "../../config/credentials"
import type { ConnectContext } from "../../providers/types"
import { PROVIDER_ID, raiseForStatus, xaiFetch } from "./api"
import { ensureAccessToken, login } from "./oauth"

const AUTH_METHODS = [
  {
    id: "subscription",
    label: "SuperGrok or X Premium subscription",
    detail: "sign in at auth.x.ai with a one-time device code",
  },
  {
    id: "api_key",
    label: "xAI API key",
    detail: "paste a key created at console.x.ai",
  },
] as const

type AuthMethod = (typeof AUTH_METHODS)[number]["id"]

const VALIDATION_TIMEOUT_MS = 15_000

async function selectMethod(ctx: ConnectContext): Promise<AuthMethod | undefined> {
  const index = await ctx.select(AUTH_METHODS.map(({ label, detail }) => ({ label, detail })))
  if (index === undefined) return undefined
  const method = AUTH_METHODS[index]
  if (!method) throw new Error("invalid authentication method selected")
  return method.id
}

async function connectApiKey(ctx: ConnectContext): Promise<Credential | undefined> {
  if (!ctx.askSecret) throw new Error("this interface cannot securely enter an xAI API key")
  const entered = await ctx.askSecret("xAI API key")
  if (entered === undefined) return undefined
  const key = entered.trim()
  if (!key) throw new Error("xAI API key cannot be empty")
  const response = await xaiFetch("/models", key, { signal: AbortSignal.timeout(VALIDATION_TIMEOUT_MS) })
  if (!response.ok) await raiseForStatus(response)
  ctx.print("connected to xAI")
  return { type: "api_key", key }
}

export async function connect(ctx: ConnectContext): Promise<Credential | undefined> {
  const method = await selectMethod(ctx)
  if (method === undefined) return undefined
  if (method === "api_key") return connectApiKey(ctx)
  return login(ctx)
}

export async function authorizedFetch(profileId: string, path: string, init: RequestInit = {}): Promise<Response> {
  const credential = await loadCredential(PROVIDER_ID, profileId)
  if (!credential) throw new Error(`not connected to xAI — run: ${appInfo.name} connect xai`)

  if (credential.type === "api_key") {
    const response = await xaiFetch(path, credential.key, init)
    if (!response.ok) await raiseForStatus(response)
    return response
  }

  let response = await xaiFetch(path, await ensureAccessToken(profileId), init)
  if (response.status === 401) response = await xaiFetch(path, await ensureAccessToken(profileId, true), init)
  if (!response.ok) await raiseForStatus(response)
  return response
}
