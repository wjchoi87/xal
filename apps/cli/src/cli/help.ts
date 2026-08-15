import { appInfo } from "../app-info"
import { listClis } from "./registry"
import type { Cli, CliContext } from "./types"

function entry(usage: string, describe: string): string {
  return `  ${`${appInfo.name} ${usage}`.padEnd(26)}${describe}`
}

export function printHelp(ctx: CliContext): void {
  ctx.print(`${appInfo.name} v${appInfo.version}`)
  ctx.print("")
  ctx.print(`usage: ${appInfo.name} [--profile] [command]`)
  ctx.print("")
  ctx.print(`  ${appInfo.name.padEnd(26)}start the chat TUI`)
  ctx.print(entry("--profile [command]", "record an anonymous diagnostic profile"))
  for (const cli of listClis()) {
    if (cli.hidden) continue
    ctx.print(entry(cli.usage ?? cli.name, cli.describe))
  }
}

export function printCliHelp(cli: Cli, ctx: CliContext): void {
  ctx.print(`usage: ${appInfo.name} ${cli.usage ?? cli.name}`)

  const subs = listClis(cli.name).filter((sub) => !sub.hidden)
  if (subs.length === 0) return

  ctx.print("")
  for (const sub of subs) {
    ctx.print(entry(`${cli.name} ${sub.name}`, sub.describe))
  }
}
