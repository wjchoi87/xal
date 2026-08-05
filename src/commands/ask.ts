import { appInfo } from "../app-info"
import { runTurn, type UiSink } from "../agent/loop"
import { Session } from "../agent/session"
import type { PermissionService } from "../permissions/service"
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
    const session = new Session()
    session.addUserMessage(text)

    const permissions: PermissionService = {
      async requestPermission(request) {
        const answer = prompt(`\n[${request.tool}] ${request.title}\nallow? [y/N]`)
        return answer?.trim().toLowerCase().startsWith("y") ? "allow" : "deny"
      },
    }

    const sink: UiSink = {
      onTextDelta: (delta) => process.stdout.write(delta),
      onThinkingDelta: () => {},
      onToolStart: (_callId, title) => ctx.print(`\n[running] ${title}`),
      onToolResult: (_callId, output, denied) => ctx.print(denied ? `[denied] ${output}` : output),
      onInterrupted: () => ctx.print("\n(interrupted)"),
      onTurnEnd: () => {},
    }

    await runTurn(session, { provider, model, permissions, sink }, new AbortController().signal)
    ctx.print("")
  },
})
