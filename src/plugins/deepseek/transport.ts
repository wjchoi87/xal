import { describeError } from "../../lib/error"
import { ProviderError } from "../../providers/errors"
import type { StreamEvent, StreamRequest, Usage } from "../../providers/types"
import { deepSeekFetch } from "./api"
import { apiKey } from "./auth"
import { assistantItem, buildMessages, parseChunk, reasoningItem, requestThinking, toolCallItem } from "./wire"

interface PendingToolCall {
  id: string
  name: string
  arguments: string
}

type SseEvent = { done: true } | { done: false; data: unknown }

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

async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer = (buffer + decoder.decode(value, { stream: true })).replaceAll("\r\n", "\n")
      let boundary: number
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const raw = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const data = raw
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("\n")
        if (!data) continue
        if (data === "[DONE]") {
          yield { done: true }
          continue
        }
        try {
          const parsed: unknown = JSON.parse(data)
          yield { done: false, data: parsed }
        } catch {}
      }
    }
  } finally {
    reader.releaseLock()
  }
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
    if (request.signal?.aborted || error instanceof ProviderError) throw error
    throw new ProviderError(`DeepSeek stream failed: ${describeError(error)}`, { retryable: true })
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
