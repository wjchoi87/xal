import type { AgentEvent } from "../../../agent/events"
import type { Screen } from "../screen"

export class AgentEventController {
  constructor(private readonly screen: Screen) {}

  handle(event: AgentEvent): void {
    const { scrollback, live, statusBar } = this.screen

    switch (event.type) {
      case "state_changed":
        statusBar.setState(event.state)
        if (event.state !== "idle") break
        this.screen.dismissApproval()
        scrollback.endStream()
        live.clear()
        break
      case "user_message":
        scrollback.append({ kind: "user", text: event.text, sentAt: event.sentAt })
        break
      case "text_delta":
        scrollback.appendStream("text", event.text)
        break
      case "reasoning_summary_delta":
        scrollback.appendStream("reasoning", event.text)
        break
      case "reasoning_delta":
        break
      case "approval_requested":
        live.request(event.callId, event.tool, event.title, event.readOnly)
        this.screen.requestApproval()
        break
      case "tool_started":
        this.screen.dismissApproval()
        scrollback.endStream()
        live.start(event.callId, event.tool, event.title, event.readOnly)
        break
      case "tool_finished": {
        this.screen.dismissApproval()
        scrollback.endStream()
        const finished = live.finish(event.callId)
        scrollback.append({
          kind: "tool",
          tool: event.tool,
          title: event.title,
          readOnly: finished?.readOnly ?? false,
          denied: event.denied,
          output: event.output,
          elapsed: finished?.elapsed,
        })
        break
      }
      case "turn_interrupted":
        scrollback.append({ kind: "info", text: "Interrupted" })
        break
      case "turn_ended":
        statusBar.setUsage(event.usage)
        break
      case "error":
        scrollback.append({ kind: "error", text: event.message })
        break
    }
  }
}
