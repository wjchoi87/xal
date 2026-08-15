import { loadCredential, saveCredential, type ApiKeyCredential } from "../../config/credentials"
import type { ConnectContext } from "../../providers/types"
import { PROVIDER_ID } from "./api"

export async function apiKey(): Promise<string> {
  const credential = await loadCredential(PROVIDER_ID)
  if (credential?.type !== "api_key") throw new Error("not connected to Alibaba Cloud — run /connect")
  return credential.key
}

export async function isLoggedIn(): Promise<boolean> {
  const credential = await loadCredential(PROVIDER_ID)
  return credential?.type === "api_key"
}

export async function connect(ctx: ConnectContext): Promise<boolean> {
  if (!ctx.askSecret) throw new Error("this interface cannot securely enter an Alibaba Cloud API key")
  const entered = await ctx.askSecret("Alibaba Cloud Model Studio API key")
  if (entered === undefined) return false
  const key = entered.trim()
  if (!key) throw new Error("Alibaba Cloud API key cannot be empty")
  const credential: ApiKeyCredential = { type: "api_key", key }
  await saveCredential(PROVIDER_ID, credential)
  ctx.print("connected to Alibaba Cloud")
  return true
}
