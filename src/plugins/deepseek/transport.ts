import { ProviderError } from "../../providers/errors"
import { sseEvents, streamError } from "../../providers/transport"
import type { StreamEvent, StreamRequest, Usage } from "../../providers/types"
import { deepSeekFetch } from "./api"
import { apiKey } from "./auth"
import { assistantItem, buildMessages, parseChunk, reasoningItem, requestThinking, toolCallItem } from "./wire"

interface PendingToolCall {
  id: string
  name: string
  arguments: string
}

function buildBody(request: StreamRequest): string {
  return JSON.stringify({
    model: request.model,
    messages: buildMessages(request.instructions, request.input),
    stream: true,
    stream_options: { include_usage: true },
    user_id: request.sessionId,
    ...requestThinking(request.thinking),
    ...(request.tools.length === 0
      ? {}
      : {
          tools: request.tools.map((tool) => ({
            type: "function",
            function: { name: tool.name, description: tool.description, parameters: tool.parameters },
          })),
        }),
  })
}

export async function* streamResponse(request: StreamRequest): AsyncGenerator<StreamEvent> {
  const response = await deepSeekFetch("/chat/completions", await apiKey(), {
    method: "POST",
    headers: { accept: "text/event-stream" },
    body: buildBody(request),
    signal: request.signal,
  })
  if (!response.body) throw new ProviderError("DeepSeek response had no body", { retryable: true })

  let text = ""
  let reasoning = ""
  let usage: Usage | undefined
  let terminal = false
  let finishReason: string | undefined
  const calls = new Map<number, PendingToolCall>()

  try {
    for await (const raw of sseEvents(response.body)) {
      if (raw.done) {
        terminal = true
        break
      }
      const chunk = parseChunk(raw.data)
      if (!chunk) continue
      if (chunk.text) {
        text += chunk.text
        yield { type: "text_delta", text: chunk.text }
      }
      if (chunk.reasoning) {
        reasoning += chunk.reasoning
        yield { type: "reasoning_summary_delta", text: chunk.reasoning }
      }
      if (chunk.usage) usage = chunk.usage
      if (chunk.finishReason) finishReason = chunk.finishReason
      for (const delta of chunk.toolCalls) {
        const call = calls.get(delta.index) ?? { id: "", name: "", arguments: "" }
        if (delta.id) call.id += delta.id
        if (delta.name) call.name += delta.name
        if (delta.arguments) call.arguments += delta.arguments
        calls.set(delta.index, call)
      }
    }
  } catch (error) {
    streamError("DeepSeek", error, request.signal)
  }

  if (!terminal) throw new ProviderError("DeepSeek stream ended unexpectedly", { retryable: true })
  if (finishReason === "insufficient_system_resource") {
    throw new ProviderError("DeepSeek had insufficient capacity to complete the response", { retryable: true })
  }
  if (reasoning) yield { type: "item_done", item: reasoningItem(reasoning) }
  yield { type: "item_done", item: assistantItem(request.model, text) }
  for (const call of [...calls.entries()].sort(([left], [right]) => left - right).map(([, call]) => call)) {
    if (!call.id || !call.name) {
      throw new ProviderError("DeepSeek returned an incomplete tool call", { retryable: false })
    }
    yield { type: "item_done", item: toolCallItem(request.model, call.id, call.name, call.arguments) }
  }
  yield { type: "done", usage }
}
