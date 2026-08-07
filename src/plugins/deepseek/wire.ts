import { asNumber, asString, isJsonObject, isRecord, type JsonObject } from "../../lib/json"
import type {
  AssistantMessageItem,
  ConversationItem,
  ProviderReplay,
  ReasoningItem,
  ThinkingEffort,
  ToolCallItem,
  Usage,
} from "../../providers/types"
import { ProviderError } from "../../providers/errors"
import { PROVIDER_ID } from "./api"

export interface ToolCallDelta {
  index: number
  id?: string
  name?: string
  arguments?: string
}

export interface Chunk {
  text?: string
  reasoning?: string
  toolCalls: ToolCallDelta[]
  finishReason?: string
  usage?: Usage
}

function assistantMessage(): JsonObject {
  return { role: "assistant", content: "" }
}

export function buildMessages(instructions: string, items: ConversationItem[]): JsonObject[] {
  const messages: JsonObject[] = [{ role: "system", content: instructions }]
  let assistant: JsonObject | undefined

  const currentAssistant = (): JsonObject => {
    assistant ??= assistantMessage()
    return assistant
  }
  const flushAssistant = (): void => {
    if (!assistant) return
    messages.push(assistant)
    assistant = undefined
  }

  for (const item of items) {
    switch (item.type) {
      case "user_message":
        flushAssistant()
        messages.push({ role: "user", content: item.text })
        break
      case "assistant_message":
        currentAssistant().content = item.text
        break
      case "reasoning":
        currentAssistant().reasoning_content = item.summary
        break
      case "tool_call": {
        const message = currentAssistant()
        const calls = Array.isArray(message.tool_calls) ? message.tool_calls : []
        calls.push({
          id: item.callId,
          type: "function",
          function: { name: item.name, arguments: JSON.stringify(item.args) },
        })
        message.tool_calls = calls
        break
      }
      case "tool_result":
        flushAssistant()
        messages.push({ role: "tool", tool_call_id: item.callId, content: item.output })
        break
    }
  }
  flushAssistant()
  return messages
}

function parseUsage(raw: unknown): Usage | undefined {
  if (!isRecord(raw)) return undefined
  return {
    totalInputTokens: asNumber(raw.prompt_tokens),
    cacheReadInputTokens: asNumber(raw.prompt_cache_hit_tokens),
    outputTokens: asNumber(raw.completion_tokens),
  }
}

export function parseChunk(raw: unknown): Chunk | undefined {
  if (!isRecord(raw)) return undefined
  if (isRecord(raw.error)) {
    throw new ProviderError(asString(raw.error.message) ?? "DeepSeek stream failed", { retryable: true })
  }
  const usage = parseUsage(raw.usage)
  if (!Array.isArray(raw.choices) || raw.choices.length === 0) {
    return usage ? { toolCalls: [], usage } : undefined
  }
  const choice = raw.choices[0]
  if (!isRecord(choice) || !isRecord(choice.delta)) return undefined
  const deltas = Array.isArray(choice.delta.tool_calls) ? choice.delta.tool_calls : []
  const toolCalls = deltas.flatMap((entry): ToolCallDelta[] => {
    if (!isRecord(entry)) return []
    const index = asNumber(entry.index)
    if (index === undefined) return []
    const fn = isRecord(entry.function) ? entry.function : undefined
    return [
      {
        index,
        id: asString(entry.id),
        name: fn ? asString(fn.name) : undefined,
        arguments: fn ? asString(fn.arguments) : undefined,
      },
    ]
  })
  return {
    text: asString(choice.delta.content),
    reasoning: asString(choice.delta.reasoning_content),
    toolCalls,
    finishReason: asString(choice.finish_reason),
    usage,
  }
}

export function requestThinking(effort: ThinkingEffort | undefined): JsonObject {
  if (effort === "none") return { thinking: { type: "disabled" } }
  return {
    thinking: { type: "enabled" },
    reasoning_effort: effort === "low" || effort === "max" ? effort : "high",
  }
}

function replay(model: string, data: JsonObject): ProviderReplay {
  return { provider: PROVIDER_ID, model, data }
}

export function reasoningItem(reasoning: string): ReasoningItem {
  return {
    type: "reasoning",
    summary: reasoning,
    replay: { provider: PROVIDER_ID, data: { reasoning_content: reasoning } },
  }
}

export function assistantItem(model: string, text: string): AssistantMessageItem {
  return { type: "assistant_message", text, replay: replay(model, { content: text }) }
}

export function toolCallItem(model: string, callId: string, name: string, argumentsText: string): ToolCallItem {
  let args: unknown
  try {
    args = JSON.parse(argumentsText)
  } catch {
    throw new ProviderError(`DeepSeek tool call ${name} had invalid JSON arguments`, { retryable: false })
  }
  if (!isJsonObject(args)) {
    throw new ProviderError(`DeepSeek tool call ${name} arguments were not an object`, { retryable: false })
  }
  return {
    type: "tool_call",
    callId,
    name,
    args,
    replay: replay(model, {
      id: callId,
      type: "function",
      function: { name, arguments: argumentsText },
    }),
  }
}
