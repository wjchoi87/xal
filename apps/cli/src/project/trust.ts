import { join } from "node:path"
import { appInfo } from "../app-info"
import { agentHome, projectConfigPath } from "../config/paths"
import { pathExists, readJsonFile, writeSecureJson } from "../lib/fs"
import { findProjectRoot } from "./root"

export interface TrustIo {
  print(line: string): void
  choose?(options: string[]): Promise<number | undefined>
}

function trustPath(): string {
  return join(agentHome(), "trust.json")
}

async function readTrusted(): Promise<string[]> {
  const path = trustPath()
  const raw = await readJsonFile(path)
  if (raw === undefined) return []
  if (!Array.isArray(raw) || !raw.every((entry): entry is string => typeof entry === "string")) {
    throw new Error(`${path} is malformed — fix or delete it`)
  }
  return raw
}

export async function isTrusted(root: string): Promise<boolean> {
  return (await readTrusted()).includes(root)
}

export async function rememberTrusted(root: string): Promise<void> {
  const trusted = await readTrusted()
  if (trusted.includes(root)) return
  await writeSecureJson(trustPath(), [...trusted, root])
}

export async function forgetTrusted(root: string): Promise<void> {
  const trusted = await readTrusted()
  if (!trusted.includes(root)) return
  await writeSecureJson(
    trustPath(),
    trusted.filter((entry) => entry !== root),
  )
}

export async function ensureWorkspaceTrust(io: TrustIo): Promise<boolean> {
  const root = await findProjectRoot(process.cwd())
  if (await isTrusted(root)) return true

  if (!io.choose) {
    if (await pathExists(projectConfigPath(root))) {
      io.print(
        `ignoring project configuration in ${projectConfigPath(root)} — run "${appInfo.name} trust grant" to enable it`,
      )
    }
    return true
  }

  io.print(`Accessing workspace: ${root}`)
  io.print("")
  io.print("Quick safety check: is this a project you created or one you trust? If not, take")
  io.print("a moment to review what's in this folder first. Untrusted contents come with a")
  io.print(`higher risk of prompt injection, and trusting the folder lets ${appInfo.name} load project`)
  io.print("configuration that can add plugins and run code.")
  io.print("")
  const choice = await io.choose(["Yes, I trust this folder", "No, exit"])
  if (choice !== 0) {
    io.print("not trusted — exiting")
    return false
  }
  await rememberTrusted(root)
  return true
}
