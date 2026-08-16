import { appInfo } from "../../app-info"
import { loadCredential } from "../../config/credentials"
import { PROVIDER_ID } from "./api"

export async function token(profileId: string): Promise<string> {
  const credential = await loadCredential(PROVIDER_ID, profileId)
  if (credential?.type !== "api_key") {
    throw new Error(`not connected to GitHub Copilot — run: ${appInfo.name} connect copilot`)
  }
  return credential.key
}
