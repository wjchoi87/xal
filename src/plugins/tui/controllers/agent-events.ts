import type { AgentSession } from "../../../agent/agent-session"
import type { AgentEvent } from "../../../agent/events"
import { contextWindow } from "../../../providers/catalog"
import type { Screen } from "../screen"

export class AgentEventController {
  constructor(
    private readonly screen: Screen,
    private readonly session: AgentSession,
  ) {}

  trackContextWindow(): void {
    const provider = this.session.currentProvider
    const model = this.session.currentModel
    this.screen.statusBar.setContextWindow(undefined)
    void contextWindow(provider, model).then((window) => {
      if (this.session.currentProvider !== provider || this.session.currentModel !== model) return
      this.screen.statusBar.setContextWindow(window)
    })
  }

  handle(event: AgentEvent): void {
    const { scrollback, live, statusBar } = this.screen

    switch (event.type) {
      case "session_started":
        this.screen.startSession(event.model, event.thinking, event.mode)
        this.trackContextWindow()
        break
      case "state_changed":
        statusBar.setState(event.state)
        if (event.state !== "idle") break
        this.screen.dismissApproval()
        scrollback.endStream()
        live.clear()
        break
      case "user_message":
        scrollback.append({ kind: "user", text: event.text, imageCount: event.imageCount, sentAt: event.sentAt })
        break
      case "queue_changed":
        this.screen.queued.set(event.entries)
        break
      case "queue_flushed":
        this.screen.composer.restore(event.inputs)
        break
      case "text_delta":
        scrollback.appendStream("text", event.text)
        break
      case "reasoning_summary_delta":
        scrollback.appendStream("reasoning", event.text)
        break
      case "reasoning_delta":
        break
      case "assistant_message":
        if (!scrollback.endStream()) scrollback.append({ kind: "text", text: event.text })
        break
      case "reasoning_summary":
        if (!scrollback.endStream()) scrollback.append({ kind: "reasoning", text: event.text })
        break
      case "retry_scheduled":
        scrollback.append({
          kind: "info",
          text: `retrying in ${Math.ceil(event.delayMs / 1_000)}s · attempt ${event.attempt}/${event.maxAttempts} · ${event.message}`,
        })
        break
      case "mode_changed":
        statusBar.setMode(event.mode)
        break
      case "model_changed":
        statusBar.setModel(event.model)
        this.trackContextWindow()
        scrollback.append({ kind: "info", text: `model: ${event.model} · ${event.provider}` })
        break
      case "thinking_changed":
        statusBar.setThinking(event.thinking)
        scrollback.append({
          kind: "info",
          text: `thinking: ${event.thinking === "none" ? "off" : (event.thinking ?? "not configurable")}`,
        })
        break
      case "approval_requested":
        live.request(event.callId, event.tool, event.title, event.readOnly)
        this.screen.requestApproval(event.suggestion)
        break
      case "tool_started":
        this.screen.dismissApproval()
        scrollback.endStream()
        live.start(event.callId, event.tool, event.title, event.readOnly)
        break
      case "tool_updated":
        live.update(event.callId, event.text)
        break
      case "tool_finished":
        this.screen.dismissApproval()
        scrollback.append({
          kind: "tool",
          tool: event.tool,
          title: event.title,
          readOnly: event.readOnly,
          denial: event.denial,
          output: event.output,
          elapsed: live.finish(event.callId),
        })
        break
      case "compacted":
        scrollback.append({
          kind: "compaction",
          summary: event.summary,
          replaced: event.replaced,
          tokensBefore: event.tokensBefore,
        })
        statusBar.resetUsage()
        break
      case "turn_interrupted":
        scrollback.append({ kind: "info", text: "Interrupted" })
        break
      case "turn_ended":
        statusBar.setUsage(event.context)
        break
      case "error":
        scrollback.append({ kind: "error", text: event.message })
        break
    }
  }
}
