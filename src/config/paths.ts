import { createHash } from "node:crypto"
import { homedir } from "node:os"
import { join } from "node:path"
import { appEnvVar, appInfo } from "../app-info"

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
  return cwd.replace(/[^a-zA-Z0-9]+/g, "-")
}

export function projectSessionsDir(cwd: string): string {
  return join(sessionsDir(), projectSlug(cwd))
}

export function projectMessageHistoryPath(root: string): string {
  return join(agentHome(), "history", `${createHash("sha256").update(root).digest("hex")}.jsonl`)
}
