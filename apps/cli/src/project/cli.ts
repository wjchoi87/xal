import { registerCli } from "../cli/registry"
import type { Cli } from "../cli/types"
import { projectConfigPath } from "../config/paths"
import { pathExists } from "../lib/fs"
import { findProjectRoot } from "./root"
import { forgetTrusted, isTrusted, rememberTrusted } from "./trust"

const trustCli: Cli = {
  name: "trust",
  describe: "show whether this directory is trusted",
  usage: "trust [grant|revoke]",
  async run(_args, ctx) {
    const root = await findProjectRoot(process.cwd())
    const configPath = projectConfigPath(root)
    const present = await pathExists(configPath)
    ctx.print(`project root: ${root}`)
    ctx.print(`project config: ${configPath}${present ? "" : " (missing)"}`)
    ctx.print(`trust: ${(await isTrusted(root)) ? "trusted" : "untrusted"}`)
  },
}

const grantCli: Cli = {
  name: "grant",
  describe: "trust this directory without the startup prompt",
  usage: "trust grant",
  async run(_args, ctx) {
    const root = await findProjectRoot(process.cwd())
    await rememberTrusted(root)
    ctx.print(`trusted: ${root}`)
  },
}

const revokeCli: Cli = {
  name: "revoke",
  describe: "stop trusting this directory",
  usage: "trust revoke",
  async run(_args, ctx) {
    const root = await findProjectRoot(process.cwd())
    await forgetTrusted(root)
    ctx.print(`untrusted: ${root}`)
  },
}

export function registerTrustClis(): void {
  registerCli(trustCli)
  registerCli(grantCli, "trust")
  registerCli(revokeCli, "trust")
}
