import type { AssistantMessageItem, ConversationItem, ProviderReplay, ReasoningItem, ToolCallItem } from "./types"

export interface ConversationTarget {
  provider: string
  model: string
}

function matches(replay: ProviderReplay | undefined, target: ConversationTarget): replay is ProviderReplay {
  return replay?.provider === target.provider && replay.model === target.model
}

function assistant(item: AssistantMessageItem, target: ConversationTarget): AssistantMessageItem {
  if (matches(item.replay, target)) return item
  return { type: "assistant_message", text: item.text }
}

function reasoning(item: ReasoningItem, target: ConversationTarget): ReasoningItem | undefined {
  return matches(item.replay, target) ? item : undefined
}

function toolCall(item: ToolCallItem, target: ConversationTarget): ToolCallItem {
  if (matches(item.replay, target)) return item
  return { type: "tool_call", callId: item.callId, name: item.name, args: item.args }
}

function portable(item: ConversationItem, target: ConversationTarget): ConversationItem | undefined {
  switch (item.type) {
    case "user_message":
    case "tool_result":
      return item
    case "assistant_message":
      return assistant(item, target)
    case "reasoning":
      return reasoning(item, target)
    case "tool_call":
      return toolCall(item, target)
  }
}

export function prepareConversation(items: ConversationItem[], target: ConversationTarget): ConversationItem[] {
  const projected = items.flatMap((item) => {
    const value = portable(item, target)
    return value ? [value] : []
  })
  const result: ConversationItem[] = []
  const pending = new Map<string, ToolCallItem>()

  const finishPending = (): void => {
    for (const call of pending.values()) {
      result.push({
        type: "tool_result",
        callId: call.callId,
        name: call.name,
        output: "Tool execution was interrupted before returning a result.",
        isError: true,
      })
    }
    pending.clear()
  }

  for (const item of projected) {
    switch (item.type) {
      case "user_message":
      case "assistant_message":
      case "reasoning":
        finishPending()
        result.push(item)
        break
      case "tool_call":
        if (pending.has(item.callId)) break
        pending.set(item.callId, item)
        result.push(item)
        break
      case "tool_result":
        if (!pending.delete(item.callId)) break
        result.push(item)
        break
    }
  }

  finishPending()
  return result
}
