import type { PermissionService } from "../permissions/service"
import type { ConversationItem, Provider, Usage } from "../providers/types"
import { getTool, listTools } from "../tools/registry"
import type { Session } from "./session"
import { systemPrompt } from "./system-prompt"

export interface UiSink {
  onTextDelta(text: string): void
  onThinkingDelta(text: string): void
  onToolStart(callId: string, title: string): void
  onToolResult(callId: string, output: string, denied: boolean): void
  onInterrupted(): void
  onTurnEnd(usage?: Usage): void
}

export interface AgentDeps {
  provider: Provider
  model: string
  permissions: PermissionService
  sink: UiSink
}

interface PendingToolCall {
  callId: string
  name: string
  args: Record<string, unknown>
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError"
}

function toolCallTitle(call: PendingToolCall): string {
  if (call.name === "bash") return String(call.args.command ?? "")
  return JSON.stringify(call.args)
}

function completedMessagesOnly(items: ConversationItem[]): ConversationItem[] {
  return items.filter((item) => item.type === "message")
}

export async function runTurn(session: Session, deps: AgentDeps, signal: AbortSignal): Promise<void> {
  let lastUsage: Usage | undefined

  while (true) {
    const pendingItems: ConversationItem[] = []
    const toolCalls: PendingToolCall[] = []

    try {
      for await (const event of deps.provider.stream({
        model: deps.model,
        instructions: systemPrompt(),
        input: session.items,
        tools: listTools().map(({ name, description, parameters }) => ({ name, description, parameters })),
        sessionId: session.id,
        signal,
      })) {
        switch (event.type) {
          case "text_delta":
            deps.sink.onTextDelta(event.text)
            break
          case "thinking_delta":
            deps.sink.onThinkingDelta(event.text)
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
        session.addItems(completedMessagesOnly(pendingItems))
        deps.sink.onInterrupted()
        return
      }
      throw error
    }

    session.addItems(pendingItems)

    if (toolCalls.length === 0) {
      deps.sink.onTurnEnd(lastUsage)
      return
    }

    for (const call of toolCalls) {
      const title = toolCallTitle(call)

      if (signal.aborted) {
        session.addToolOutput(call.callId, "Interrupted by user before execution.")
        continue
      }

      const tool = getTool(call.name)
      if (!tool) {
        const message = `Unknown tool: ${call.name}`
        session.addToolOutput(call.callId, message)
        deps.sink.onToolResult(call.callId, message, true)
        continue
      }

      const decision = await deps.permissions.requestPermission({ tool: call.name, title })
      if (decision === "deny") {
        const message = "User denied permission to run this command."
        session.addToolOutput(call.callId, message)
        deps.sink.onToolResult(call.callId, message, true)
        continue
      }

      deps.sink.onToolStart(call.callId, title)
      let output: string
      try {
        output = (await tool.execute(call.args, signal)).output
      } catch (error) {
        output = `Tool failed: ${error instanceof Error ? error.message : String(error)}`
      }
      session.addToolOutput(call.callId, output)
      deps.sink.onToolResult(call.callId, output, false)
    }

    if (signal.aborted) {
      deps.sink.onInterrupted()
      return
    }
  }
}
