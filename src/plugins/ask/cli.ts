import { createSession } from "../../agent/compose"
import { appInfo } from "../../app-info"
import type { Cli } from "../../cli/types"
import { isPermissionMode, permissionModes, type PermissionMode } from "../../permissions/types"

interface Parsed {
  text: string
  mode: PermissionMode
}

function parseArgs(args: string[]): Parsed {
  const rest: string[] = []
  let mode: PermissionMode = "build"

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg !== "--mode") {
      rest.push(arg)
      continue
    }
    const value = args[++index]
    if (!value || !isPermissionMode(value)) {
      throw new Error(`--mode expects one of: ${permissionModes.join(", ")}`)
    }
    mode = value
  }

  return { text: rest.join(" ").trim(), mode }
}

export const askCli: Cli = {
  name: "ask",
  hidden: true,
  describe: "one-shot debug prompt streamed to stdout",
  async run(args, ctx) {
    const { text, mode } = parseArgs(args)
    if (!text) throw new Error(`usage: ${appInfo.name} ask [--mode ${permissionModes.join("|")}] <prompt>`)

    const { session } = await createSession()
    session.setMode(mode)

    await new Promise<void>((resolve) => {
      session.subscribe((event) => {
        switch (event.type) {
          case "text_delta":
            process.stdout.write(event.text)
            break
          case "approval_requested": {
            if (!process.stdin.isTTY) {
              const message = "This action needed approval but the session is headless, so it was not run."
              ctx.print(`\n${message} Rerun with --mode auto to allow it.`)
              session.deny("policy", message)
              break
            }
            const answer = prompt(`\n[${event.tool}] ${event.title}\nallow? [y/N]`)
            if (answer?.trim().toLowerCase().startsWith("y")) session.approve()
            else session.deny()
            break
          }
          case "tool_started":
            ctx.print(`\n[running] ${event.title}`)
            break
          case "tool_finished":
            ctx.print(event.denial ? `[${event.denial}] ${event.output}` : event.output)
            break
          case "compacted":
            ctx.print(`\n[context compacted · ${event.replaced} items summarized]`)
            break
          case "retry_scheduled":
            ctx.print(
              `[retrying in ${Math.ceil(event.delayMs / 1_000)}s · attempt ${event.attempt}/${event.maxAttempts}] ${event.message}`,
            )
            break
          case "error":
            ctx.print(`\n${event.message}`)
            resolve()
            break
          case "turn_ended":
          case "turn_interrupted":
            resolve()
            break
          default:
            break
        }
      })
      session.send({ text, images: [] })
    })
    ctx.print("")
  },
}
