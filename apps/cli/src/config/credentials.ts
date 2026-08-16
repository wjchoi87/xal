import { mkdir, rmdir, stat } from "node:fs/promises"
import { dirname } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { readJsonFile, writeSecureJson } from "../lib/fs"
import { asNumber, asString, isRecord } from "../lib/json"
import { replaceSecretValues } from "../secrets/redactor"
import { credentialsPath } from "./paths"

export interface OAuthCredential {
  type: "oauth"
  access: string
  refresh: string
  expires: number
  accountId?: string
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
  if (!access || !refresh || expires === undefined) return undefined
  return { type: "oauth", access, refresh, expires, ...(accountId ? { accountId } : {}) }
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

async function acquireCredentialLock(): Promise<() => Promise<void>> {
  const path = `${credentialsPath()}.lock`
  await mkdir(dirname(path), { recursive: true })
  const deadline = Date.now() + 10_000
  while (true) {
    try {
      await mkdir(path)
      return () => rmdir(path)
    } catch (error) {
      if (!isRecord(error) || error.code !== "EEXIST") throw error
    }

    try {
      const info = await stat(path)
      if (Date.now() - info.mtimeMs > 10_000) {
        await rmdir(path)
        continue
      }
    } catch (error) {
      if (!isRecord(error) || (error.code !== "ENOENT" && error.code !== "ENOTDIR")) throw error
      continue
    }

    if (Date.now() >= deadline) throw new Error(`timed out waiting for credential lock ${path}`)
    await sleep(25)
  }
}

export async function saveCredential(providerId: string, credential: Credential): Promise<void> {
  const release = await acquireCredentialLock()
  try {
    const providers = await loadProviders()
    providers[providerId] = credential
    await writeSecureJson(credentialsPath(), { providers })
    replaceSecretValues("credentials", secretValues(providers))
  } finally {
    await release()
  }
}
