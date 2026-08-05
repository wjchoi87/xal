import { homedir } from "node:os"
import { join } from "node:path"
import { appInfo } from "../app-info"

export function configDir(): string {
  const base = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config")
  return join(base, appInfo.name)
}

export function credentialsPath(): string {
  return join(configDir(), "credentials.json")
}

export function cacheDir(): string {
  return join(configDir(), "cache")
}
