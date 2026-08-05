import { AgentSession } from "../agent/agent-session"
import { appInfo } from "../app-info"
import { askPolicy } from "../permissions/service"
import { getProvider } from "../providers/registry"
import { registerCommand } from "./registry"

registerCommand({
  name: "ask",
  hidden: true,
  describe: "one-shot debug prompt streamed to stdout",
  async run(args, ctx) {
    const text = args.join(" ").trim()
    if (!text) throw new Error(`usage: ${appInfo.name} ask <prompt>`)

    const provider = getProvider("chatgpt")!
    const model = await provider.defaultModel()
    const session = new AgentSession({ provider, model, policy: askPolicy })

    await new Promise<void>((resolve) => {
      session.subscribe((event) => {
        switch (event.type) {
          case "text_delta":
            process.stdout.write(event.text)
            break
          case "approval_requested": {
            const answer = prompt(`\n[${event.tool}] ${event.title}\nallow? [y/N]`)
            if (answer?.trim().toLowerCase().startsWith("y")) session.approve()
            else session.deny()
            break
          }
          case "tool_started":
            ctx.print(`\n[running] ${event.title}`)
            break
          case "tool_finished":
            ctx.print(event.denied ? `[denied] ${event.output}` : event.output)
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
      session.send(text)
    })
    ctx.print("")
  },
})
