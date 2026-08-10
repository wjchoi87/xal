import { createHash } from "node:crypto"
import { homedir } from "node:os"
import { join } from "node:path"
import { appEnvVar, appInfo } from "../app-info"
import { redactText } from "../secrets/redactor"

export function agentHome(): string {
  return process.env[appEnvVar("HOME")]?.trim() || join(homedir(), `.${appInfo.name}`)
}

export function projectConfigPath(root: string): string {
  return join(root, `.${appInfo.name}`, "config.json")
}

export function credentialsPath(): string {
  return join(agentHome(), "credentials.json")
}

export function cacheDir(): string {
  return join(agentHome(), "cache")
}

export function sessionsDir(): string {
  return join(agentHome(), "sessions")
}

export function worktreesDir(): string {
  return join(agentHome(), "worktrees")
}

function projectSlug(cwd: string): string {
  const redacted = redactText(cwd)
  const slug = redacted.replace(/[^a-zA-Z0-9]+/g, "-")
  if (redacted === cwd) return slug
  return `${slug}-${createHash("sha256").update(cwd).digest("hex").slice(0, 12)}`
}

export function projectSessionsDir(cwd: string): string {
  return join(sessionsDir(), projectSlug(cwd))
}

export function projectMessageHistoryPath(root: string): string {
  return join(agentHome(), "history", `${createHash("sha256").update(root).digest("hex")}.jsonl`)
}
