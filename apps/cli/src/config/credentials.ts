import { readJsonFile, writeSecureJson } from "../lib/fs"
import { asNumber, asString, isRecord } from "../lib/json"
import { replaceSecretValues } from "../secrets/redactor"
import { credentialsPath } from "./paths"

export interface OAuthCredential {
  type: "oauth"
  access: string
  refresh: string
  expires: number
  accountId: string
}

export interface ApiKeyCredential {
  type: "api_key"
  key: string
}

export type Credential = OAuthCredential | ApiKeyCredential

function secretValues(providers: Record<string, Credential>): string[] {
  return Object.values(providers).flatMap((credential) => {
    if (credential.type === "api_key") return [credential.key]
    return [credential.access, credential.refresh]
  })
}

function parseCredential(raw: unknown): Credential | undefined {
  if (!isRecord(raw)) return undefined
  if (raw.type === "api_key") {
    const key = asString(raw.key)
    return key ? { type: "api_key", key } : undefined
  }
  if (raw.type !== "oauth") return undefined
  const access = asString(raw.access)
  const refresh = asString(raw.refresh)
  const expires = asNumber(raw.expires)
  const accountId = asString(raw.accountId)
  if (!access || !refresh || expires === undefined || !accountId) return undefined
  return { type: "oauth", access, refresh, expires, accountId }
}

async function loadProviders(): Promise<Record<string, Credential>> {
  const path = credentialsPath()
  const parsed = await readJsonFile(path)
  if (parsed === undefined) {
    replaceSecretValues("credentials", [])
    return {}
  }
  if (!isRecord(parsed) || !isRecord(parsed.providers)) {
    throw new Error(`${path} is malformed — fix or delete it`)
  }
  const providers: Record<string, Credential> = {}
  for (const [providerId, raw] of Object.entries(parsed.providers)) {
    const credential = parseCredential(raw)
    if (!credential) throw new Error(`${path} has a malformed credential for ${providerId} — fix or delete it`)
    providers[providerId] = credential
  }
  replaceSecretValues("credentials", secretValues(providers))
  return providers
}

export async function loadCredentialSecrets(): Promise<void> {
  await loadProviders()
}

export async function loadCredential(providerId: string): Promise<Credential | undefined> {
  return (await loadProviders())[providerId]
}

export async function saveCredential(providerId: string, credential: Credential): Promise<void> {
  const providers = await loadProviders()
  providers[providerId] = credential
  await writeSecureJson(credentialsPath(), { providers })
  replaceSecretValues("credentials", secretValues(providers))
}
