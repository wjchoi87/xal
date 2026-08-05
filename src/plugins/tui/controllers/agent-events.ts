import type { AgentEvent } from "../../../agent/events"
import type { StreamingText } from "../components/streaming-text"
import type { ToolCell } from "../components/tool-cell"
import type { Screen } from "../screen"

export class AgentEventController {
  private assistant: StreamingText | undefined
  private reasoning: StreamingText | undefined
  private readonly toolCells = new Map<string, ToolCell>()

  constructor(private readonly screen: Screen) {}

  handle(event: AgentEvent): void {
    const { chatLog, composer, statusBar } = this.screen

    switch (event.type) {
      case "state_changed":
        statusBar.setState(event.state)
        if (event.state === "awaiting_approval") composer.blur()
        else composer.focus()
        if (event.state !== "idle") break
        this.screen.dismissApproval()
        this.resetStreams()
        this.toolCells.clear()
        break
      case "user_message":
        chatLog.addUser(event.text, event.sentAt)
        break
      case "text_delta":
        this.reasoning = undefined
        this.assistant ??= chatLog.startAssistant()
        this.assistant.append(event.text)
        break
      case "reasoning_summary_delta":
        this.reasoning ??= chatLog.startReasoningSummary()
        this.reasoning.append(event.text)
        break
      case "reasoning_delta":
        break
      case "approval_requested":
        this.toolCells.set(event.callId, chatLog.addToolCell(event.tool, event.title, event.readOnly))
        this.screen.requestApproval(event.title)
        break
      case "tool_started": {
        this.screen.dismissApproval()
        const cell = this.cell(event.callId, event.tool, event.title, event.readOnly)
        this.toolCells.set(event.callId, cell)
        cell.markRunning()
        this.resetStreams()
        break
      }
      case "tool_finished": {
        this.screen.dismissApproval()
        const cell = this.cell(event.callId, event.tool, event.title, false)
        if (event.denied) cell.markDenied(event.output)
        else cell.setOutput(event.output)
        this.toolCells.delete(event.callId)
        this.resetStreams()
        break
      }
      case "turn_interrupted":
        chatLog.addInfo("Interrupted")
        break
      case "turn_ended":
        composer.setUsage(event.usage)
        break
      case "error":
        chatLog.addError(event.message)
        break
    }
  }

  private cell(callId: string, tool: string, title: string, readOnly: boolean): ToolCell {
    return this.toolCells.get(callId) ?? this.screen.chatLog.addToolCell(tool, title, readOnly)
  }

  private resetStreams(): void {
    this.assistant = undefined
    this.reasoning = undefined
  }
}
