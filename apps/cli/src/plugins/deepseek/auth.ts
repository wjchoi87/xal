import { loadCredential, type ApiKeyCredential } from "../../config/credentials"
import type { ConnectContext } from "../../providers/types"
import { deepSeekFetch, PROVIDER_ID } from "./api"

export async function apiKey(profileId: string): Promise<string> {
  const credential = await loadCredential(PROVIDER_ID, profileId)
  if (credential?.type !== "api_key") throw new Error("not connected to DeepSeek — run /connect")
  return credential.key
}

export async function connect(ctx: ConnectContext): Promise<ApiKeyCredential | undefined> {
  if (!ctx.askSecret) throw new Error("this interface cannot securely enter a DeepSeek API token")
  const entered = await ctx.askSecret("DeepSeek API token")
  if (entered === undefined) return undefined
  const key = entered.trim()
  if (!key) throw new Error("DeepSeek API token cannot be empty")
  await deepSeekFetch("/models", key, { signal: AbortSignal.timeout(15_000) })
  ctx.print("connected to DeepSeek")
  return { type: "api_key", key }
}
