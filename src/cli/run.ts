import { appInfo } from "../app-info"
import { printCliHelp, printHelp } from "./help"
import { resolveCli } from "./registry"
import type { CliContext } from "./types"

export async function runCli(args: string[], ctx: CliContext): Promise<void> {
  const first = args[0]
  if (!first || first === "--help" || first === "-h" || first === "help") {
    printHelp(ctx)
    return
  }
  if (first === "--version" || first === "-v" || first === "version") {
    ctx.print(`${appInfo.name} ${appInfo.version}`)
    return
  }

  const resolved = resolveCli(args)
  if (!resolved) {
    ctx.print(`unknown command: ${first}`)
    printHelp(ctx)
    process.exit(1)
  }

  if (!resolved.cli.run) {
    const unknown = resolved.args[0]
    if (unknown) ctx.print(`unknown ${resolved.cli.name} target: ${unknown}`)
    printCliHelp(resolved.cli, ctx)
    if (unknown) process.exit(1)
    return
  }

  try {
    await resolved.cli.run(resolved.args, ctx)
  } catch (error) {
    ctx.print(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
