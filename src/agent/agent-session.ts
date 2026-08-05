import type { PermissionPolicy } from "../permissions/service"
import type { ConversationItem, Provider, Usage } from "../providers/types"
import { getTool, listTools } from "../tools/registry"
import type { AgentEvent, AgentState } from "./events"
import { systemPrompt } from "./system-prompt"

export interface AgentSessionDeps {
  provider: Provider
  model: string
  policy: PermissionPolicy
}

interface PendingToolCall {
  callId: string
  name: string
  args: Record<string, unknown>
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError"
}

export class AgentSession {
  readonly id = crypto.randomUUID()
  private readonly items: ConversationItem[] = []
  private readonly listeners = new Set<(event: AgentEvent) => void>()
  private state: AgentState = "idle"
  private abortController: AbortController | undefined
  private pendingApproval: ((decision: "allow" | "deny") => void) | undefined

  constructor(private readonly deps: AgentSessionDeps) {}

  get currentState(): AgentState {
    return this.state
  }

  subscribe(listener: (event: AgentEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  send(text: string): boolean {
    if (this.state !== "idle") return false
    this.items.push({ role: "user", content: [{ type: "input_text", text }] })
    this.emit({ type: "user_message", text, sentAt: Date.now() })
    const controller = new AbortController()
    this.abortController = controller
    void this.runTurn(controller.signal)
      .catch((error) => {
        this.emit({ type: "error", message: error instanceof Error ? error.message : String(error) })
      })
      .finally(() => {
        this.abortController = undefined
        this.setState("idle")
      })
    return true
  }

  approve(): void {
    this.resolveApproval("allow")
  }

  deny(): void {
    this.resolveApproval("deny")
  }

  interrupt(): void {
    this.abortController?.abort()
    this.resolveApproval("deny")
  }

  private resolveApproval(decision: "allow" | "deny"): void {
    const resolve = this.pendingApproval
    if (!resolve) return
    this.pendingApproval = undefined
    resolve(decision)
  }

  private emit(event: AgentEvent): void {
    for (const listener of this.listeners) listener(event)
  }

  private setState(state: AgentState): void {
    if (this.state === state) return
    this.state = state
    this.emit({ type: "state_changed", state })
  }

  private addToolOutput(callId: string, output: string): void {
    this.items.push({ type: "function_call_output", call_id: callId, output })
  }

  private async runTurn(signal: AbortSignal): Promise<void> {
    let lastUsage: Usage | undefined

    while (true) {
      const pendingItems: ConversationItem[] = []
      const toolCalls: PendingToolCall[] = []
      this.setState("streaming")

      try {
        for await (const event of this.deps.provider.stream({
          model: this.deps.model,
          instructions: systemPrompt(),
          input: this.items,
          tools: listTools().map(({ name, description, parameters }) => ({ name, description, parameters })),
          sessionId: this.id,
          signal,
        })) {
          switch (event.type) {
            case "text_delta":
              this.emit({ type: "text_delta", text: event.text })
              break
            case "reasoning_summary_delta":
              this.emit({ type: "reasoning_summary_delta", text: event.text })
              break
            case "reasoning_delta":
              this.emit({ type: "reasoning_delta", text: event.text })
              break
            case "item_done":
              pendingItems.push(event.item)
              break
            case "tool_call":
              toolCalls.push({ callId: event.callId, name: event.name, args: event.args })
              break
            case "done":
              lastUsage = event.usage ?? lastUsage
              break
          }
        }
      } catch (error) {
        if (isAbortError(error) || signal.aborted) {
          this.items.push(...pendingItems.filter((item) => item.type === "message"))
          this.emit({ type: "turn_interrupted" })
          return
        }
        throw error
      }

      this.items.push(...pendingItems)

      if (toolCalls.length === 0) {
        this.emit({ type: "turn_ended", usage: lastUsage })
        return
      }

      for (const call of toolCalls) {
        await this.handleToolCall(call, signal)
      }

      if (signal.aborted) {
        this.emit({ type: "turn_interrupted" })
        return
      }
    }
  }

  private async handleToolCall(call: PendingToolCall, signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
      this.addToolOutput(call.callId, "Interrupted by user before execution.")
      return
    }

    const title = call.name === "bash" ? String(call.args.command ?? "") : JSON.stringify(call.args)
    const tool = getTool(call.name)
    if (!tool) {
      const message = `Unknown tool: ${call.name}`
      this.addToolOutput(call.callId, message)
      this.emit({ type: "tool_finished", callId: call.callId, title, output: message, denied: true })
      return
    }

    let decision = this.deps.policy.evaluate({ tool: call.name, title })
    if (decision === "ask") {
      const asked = new Promise<"allow" | "deny">((resolve) => {
        this.pendingApproval = resolve
      })
      this.setState("awaiting_approval")
      this.emit({ type: "approval_requested", callId: call.callId, tool: call.name, title })
      decision = await asked
    }

    if (decision === "deny") {
      const message = "User denied permission to run this command."
      this.addToolOutput(call.callId, message)
      this.emit({ type: "tool_finished", callId: call.callId, title, output: message, denied: true })
      return
    }

    this.setState("running_tool")
    this.emit({ type: "tool_started", callId: call.callId, title })
    let output: string
    try {
      output = (await tool.execute(call.args, signal)).output
    } catch (error) {
      output = `Tool failed: ${error instanceof Error ? error.message : String(error)}`
    }
    this.addToolOutput(call.callId, output)
    this.emit({ type: "tool_finished", callId: call.callId, title, output, denied: false })
  }
}
