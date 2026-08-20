import { loadCredential, type ApiKeyCredential } from "../../config/credentials"
import type { ConnectContext } from "../../providers/types"
import { providerName, type MiniMaxProviderId } from "./api"

export async function apiKey(providerId: MiniMaxProviderId, profileId: string): Promise<string> {
  const credential = await loadCredential(providerId, profileId)
  if (credential?.type !== "api_key") throw new Error(`not connected to ${providerName(providerId)}; run /connect`)
  return credential.key
}

export async function connect(
  providerId: MiniMaxProviderId,
  ctx: ConnectContext,
): Promise<ApiKeyCredential | undefined> {
  const name = providerName(providerId)
  if (!ctx.askSecret) throw new Error(`this interface cannot securely enter a ${name} API key`)
  const entered = await ctx.askSecret(`${name} API key`)
  if (entered === undefined) return undefined
  const key = entered.trim()
  if (!key) throw new Error(`${name} API key cannot be empty`)
  ctx.print(`connected to ${name}`)
  return { type: "api_key", key }
}
