import { appInfo } from "../../app-info"
import { loadCredential, type ApiKeyCredential } from "../../config/credentials"
import type { ConnectContext } from "../../providers/types"
import { openAiFetch, PROVIDER_ID, raiseForStatus } from "./api-client"

const VALIDATION_TIMEOUT_MS = 15_000

export async function apiKey(profileId: string): Promise<string> {
  const credential = await loadCredential(PROVIDER_ID, profileId)
  if (credential?.type !== "api_key") throw new Error(`not connected to OpenAI - run: ${appInfo.name} connect openai`)
  return credential.key
}

export async function connect(ctx: ConnectContext): Promise<ApiKeyCredential | undefined> {
  if (!ctx.askSecret) throw new Error("this interface cannot securely enter an OpenAI API key")
  const entered = await ctx.askSecret("OpenAI API key")
  if (entered === undefined) return undefined
  const key = entered.trim()
  if (!key) throw new Error("OpenAI API key cannot be empty")
  const response = await openAiFetch("/models", key, { signal: AbortSignal.timeout(VALIDATION_TIMEOUT_MS) })
  if (!response.ok) await raiseForStatus(response)
  ctx.print("connected to OpenAI")
  return { type: "api_key", key }
}
