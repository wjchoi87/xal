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

interface CredentialsFile {
  version: 1
  providers: Record<string, Credential>
}

const emptyFile = (): CredentialsFile => ({ version: 1, providers: {} })

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

async function loadFile(): Promise<CredentialsFile> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(credentialsPath(), "utf8"))
  } catch {
    return emptyFile()
  }
  if (!isRecord(parsed) || !isRecord(parsed.providers)) return emptyFile()
  const providers: Record<string, Credential> = {}
  for (const [providerId, raw] of Object.entries(parsed.providers)) {
    const credential = parseCredential(raw)
    if (credential) providers[providerId] = credential
  }
  return { version: 1, providers }
}

export async function loadCredential(providerId: string): Promise<Credential | undefined> {
  const file = await loadFile()
  return file.providers[providerId]
}

export async function saveCredential(providerId: string, credential: Credential): Promise<void> {
  const file = await loadFile()
  file.providers[providerId] = credential
  const path = credentialsPath()
  const dir = dirname(path)
  await mkdir(dir, { recursive: true })
  const tmp = join(dir, `.credentials.${process.pid}.${Date.now()}.tmp`)
  await writeFile(tmp, JSON.stringify(file, null, 2) + "\n", { mode: 0o600 })
  await rename(tmp, path)
  await chmod(path, 0o600)
}

export async function deleteCredential(providerId: string): Promise<void> {
  const file = await loadFile()
  if (!(providerId in file.providers)) return
  delete file.providers[providerId]
  const path = credentialsPath()
  await mkdir(dirname(path), { recursive: true })
  const tmp = join(dirname(path), `.credentials.${process.pid}.${Date.now()}.tmp`)
  await writeFile(tmp, JSON.stringify(file, null, 2) + "\n", { mode: 0o600 })
  await rename(tmp, path)
  await chmod(path, 0o600)
}
