import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { asNumber, asString, isRecord } from "../lib/json"
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
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(credentialsPath(), "utf8"))
  } catch {
    return {}
  }
  if (!isRecord(parsed) || !isRecord(parsed.providers)) return {}
  const providers: Record<string, Credential> = {}
  for (const [providerId, raw] of Object.entries(parsed.providers)) {
    const credential = parseCredential(raw)
    if (credential) providers[providerId] = credential
  }
  return providers
}

async function saveProviders(providers: Record<string, Credential>): Promise<void> {
  const path = credentialsPath()
  const dir = dirname(path)
  await mkdir(dir, { recursive: true })
  const tmp = join(dir, `.credentials.${process.pid}.${Date.now()}.tmp`)
  await writeFile(tmp, JSON.stringify({ providers }, null, 2) + "\n", { mode: 0o600 })
  await rename(tmp, path)
  await chmod(path, 0o600)
}

export async function loadCredential(providerId: string): Promise<Credential | undefined> {
  return (await loadProviders())[providerId]
}

export async function saveCredential(providerId: string, credential: Credential): Promise<void> {
  const providers = await loadProviders()
  providers[providerId] = credential
  await saveProviders(providers)
}

export async function deleteCredential(providerId: string): Promise<void> {
  const providers = await loadProviders()
  if (!(providerId in providers)) return
  delete providers[providerId]
  await saveProviders(providers)
}
