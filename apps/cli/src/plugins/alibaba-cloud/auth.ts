import { loadCredential, type ApiKeyCredential } from "../../config/credentials"
import type { ConnectContext } from "../../providers/types"
import { PROVIDER_ID } from "./api"

export async function apiKey(profileId: string): Promise<string> {
  const credential = await loadCredential(PROVIDER_ID, profileId)
  if (credential?.type !== "api_key") throw new Error("not connected to Alibaba Cloud — run /connect")
  return credential.key
}

export async function connect(ctx: ConnectContext): Promise<ApiKeyCredential | undefined> {
  if (!ctx.askSecret) throw new Error("this interface cannot securely enter an Alibaba Cloud API key")
  const entered = await ctx.askSecret("Alibaba Cloud Model Studio API key")
  if (entered === undefined) return undefined
  const key = entered.trim()
  if (!key) throw new Error("Alibaba Cloud API key cannot be empty")
  ctx.print("connected to Alibaba Cloud")
  return { type: "api_key", key }
}
