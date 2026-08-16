import { asNumber, asString, isJsonObject, isRecord, type JsonObject } from "../../lib/json"
import { replayMatches, type ConversationTarget } from "../../providers/conversation"
import { ProviderError } from "../../providers/errors"
import { parseToolArgs, sseEvents, streamError } from "../../providers/transport"
import type {
  ConversationItem,
  ProviderOutputItem,
  ProviderReplay,
  StreamEvent,
  StreamRequest,
  ThinkingEffort,
  Usage,
} from "../../providers/types"
import { anthropicFetch } from "./api"
import { ensureAuth, PROVIDER_ID } from "./auth"

interface WireMessage {
  role: "user" | "assistant"
  content: JsonObject[]
}

interface BlockState {
  type: "text" | "thinking" | "tool_use"
  data: JsonObject
  text: string
  partialJson: string
}

const CLAUDE_CODE_TOOL_NAMES = [
  "Read",
  "Write",
  "Edit",
  "Bash",
  "Grep",
  "Glob",
  "AskUserQuestion",
  "EnterPlanMode",
  "ExitPlanMode",
  "KillShell",
  "NotebookEdit",
  "Skill",
  "Task",
  "TaskOutput",
  "TodoWrite",
  "WebFetch",
  "WebSearch",
]

function oauthToolName(name: string): string {
  return CLAUDE_CODE_TOOL_NAMES.find((candidate) => candidate.toLowerCase() === name.toLowerCase()) ?? name
}

function xalToolName(name: string, tools: StreamRequest["tools"]): string {
  return tools.find((tool) => tool.name.toLowerCase() === name.toLowerCase())?.name ?? name
}

function replay(data: JsonObject, target: ConversationTarget): ProviderReplay {
  return { provider: target.provider, model: target.model, data }
}

function replayData(item: { replay?: ProviderReplay }, target: ConversationTarget): JsonObject | undefined {
  return replayMatches(item.replay, target) ? item.replay.data : undefined
}

function userContent(item: Extract<ConversationItem, { type: "user_message" }>): JsonObject[] {
  return [
    ...(item.text ? [{ type: "text", text: item.text }] : []),
    ...item.images.map((image) => ({
      type: "image",
      source: { type: "base64", media_type: image.mediaType, data: image.data },
    })),
  ]
}

function assistantContent(item: ConversationItem, target: ConversationTarget, oauth: boolean): JsonObject[] {
  switch (item.type) {
    case "assistant_message":
      return [replayData(item, target) ?? { type: "text", text: item.text }]
    case "reasoning": {
      const data = replayData(item, target)
      return data ? [data] : []
    }
    case "tool_call": {
      const data = replayData(item, target) ?? {
        type: "tool_use",
        id: item.callId,
        name: item.name,
        input: item.args,
      }
      const name = asString(data.name)
      return oauth && name ? [{ ...data, name: oauthToolName(name) }] : [data]
    }
    case "user_message":
    case "tool_result":
      return []
  }
}

function buildMessages(items: ConversationItem[], target: ConversationTarget, oauth: boolean): WireMessage[] {
  const messages: WireMessage[] = []
  for (const item of items) {
    if (item.type === "user_message") {
      messages.push({ role: "user", content: userContent(item) })
      continue
    }
    if (item.type === "tool_result") {
      messages.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: item.callId, content: item.output }],
      })
      continue
    }
    const content = assistantContent(item, target, oauth)
    if (content.length > 0) messages.push({ role: "assistant", content })
  }

  const lastUser = messages.findLast((message) => message.role === "user")
  const lastBlock = lastUser?.content.at(-1)
  if (lastBlock) lastBlock.cache_control = { type: "ephemeral" }
  return messages
}

function maxTokens(model: string): number {
  if (model.includes("-4-5")) return 64_000
  if (adaptiveThinking(model)) return 128_000
  return 32_000
}

function adaptiveThinking(model: string): boolean {
  return [
    "opus-4-6",
    "opus-4.6",
    "opus-4-7",
    "opus-4.7",
    "opus-4-8",
    "opus-4.8",
    "opus-5",
    "opus.5",
    "sonnet-4-6",
    "sonnet-4.6",
    "sonnet-5",
    "sonnet.5",
    "fable-5",
  ].some((part) => model.includes(part))
}

function thinkingOptions(model: string, effort: ThinkingEffort | undefined, outputTokens: number): JsonObject {
  if (!effort) return {}
  if (effort === "none") return { thinking: { type: "disabled" } }
  if (adaptiveThinking(model)) {
    return {
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort },
    }
  }
  const requested = effort === "low" ? 1_024 : effort === "medium" ? 4_096 : effort === "high" ? 8_192 : 16_384
  return {
    thinking: {
      type: "enabled",
      budget_tokens: Math.min(requested, outputTokens - 1_024),
      display: "summarized",
    },
  }
}

function buildSystem(instructions: string, oauth: boolean): JsonObject[] | undefined {
  const system: JsonObject[] = []
  if (oauth) {
    system.push({
      type: "text",
      text: "You are Claude Code, Anthropic's official CLI for Claude.",
      cache_control: { type: "ephemeral" },
    })
  }
  if (instructions) {
    system.push({ type: "text", text: instructions, cache_control: { type: "ephemeral" } })
  }
  return system.length > 0 ? system : undefined
}

function buildBody(request: StreamRequest, oauth: boolean): string {
  const outputTokens = maxTokens(request.model)
  const tools = request.tools.map((tool, index) => ({
    name: oauth ? oauthToolName(tool.name) : tool.name,
    description: tool.description,
    input_schema: tool.parameters,
    ...(index === request.tools.length - 1 ? { cache_control: { type: "ephemeral" } } : {}),
  }))
  return JSON.stringify({
    model: request.model,
    messages: buildMessages(request.input, { provider: PROVIDER_ID, model: request.model }, oauth),
    max_tokens: outputTokens,
    stream: true,
    ...thinkingOptions(request.model, request.thinking, outputTokens),
    ...(buildSystem(request.instructions, oauth) ? { system: buildSystem(request.instructions, oauth) } : {}),
    ...(tools.length > 0 ? { tools } : {}),
    ...(request.toolChoice === "none" ? { tool_choice: { type: "none" } } : {}),
    metadata: { user_id: request.sessionId },
  })
}

function usageFrom(raw: unknown, previous: Usage): Usage {
  if (!isRecord(raw)) return previous
  const input = asNumber(raw.input_tokens)
  const cacheRead = asNumber(raw.cache_read_input_tokens)
  const cacheWrite = asNumber(raw.cache_creation_input_tokens)
  return {
    totalInputTokens:
      input === undefined && cacheRead === undefined && cacheWrite === undefined
        ? previous.totalInputTokens
        : (input ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0),
    cacheReadInputTokens: cacheRead ?? previous.cacheReadInputTokens,
    cacheWriteInputTokens: cacheWrite ?? previous.cacheWriteInputTokens,
    outputTokens: asNumber(raw.output_tokens) ?? previous.outputTokens,
  }
}

function transientFailure(message: string): boolean {
  return /overloaded|rate.?limit|server.?error|service.?unavailable|internal.?error|timeout|try again/i.test(message)
}

function failure(raw: Record<string, unknown>): ProviderError {
  const error = isRecord(raw.error) ? raw.error : raw
  const message = asString(error.message) ?? "Anthropic stream failed"
  return new ProviderError(message, { retryable: transientFailure(`${asString(error.type) ?? ""} ${message}`) })
}

function handleStopReason(raw: unknown): void {
  if (!isRecord(raw)) return
  const reason = asString(raw.stop_reason)
  switch (reason) {
    case undefined:
    case "end_turn":
    case "tool_use":
    case "pause_turn":
    case "stop_sequence":
      return
    case "max_tokens":
      throw new ProviderError("Anthropic response exceeded the model output limit", { retryable: false })
    case "refusal": {
      const details = isRecord(raw.stop_details) ? asString(raw.stop_details.explanation) : undefined
      throw new ProviderError(details ? `Anthropic refused the request: ${details}` : "Anthropic refused the request", {
        retryable: false,
      })
    }
    case "sensitive":
      throw new ProviderError("Anthropic stopped the response because it detected sensitive content", {
        retryable: false,
      })
    default:
      throw new Error(`Anthropic returned an unknown stop reason: ${reason}`)
  }
}

function startBlock(raw: Record<string, unknown>): BlockState | undefined {
  if (!isJsonObject(raw.content_block)) throw new Error("Anthropic content block was invalid")
  const data = raw.content_block
  const type = asString(data.type)
  if (type === "text") {
    const text = asString(data.text) ?? ""
    return { type, data, text, partialJson: "" }
  }
  if (type === "thinking" || type === "redacted_thinking") {
    const text = type === "redacted_thinking" ? "[Reasoning redacted]" : (asString(data.thinking) ?? "")
    return { type: "thinking", data, text, partialJson: "" }
  }
  if (type === "tool_use") return { type, data, text: "", partialJson: "" }
  return undefined
}

function finishBlock(
  block: BlockState,
  target: ConversationTarget,
  tools: StreamRequest["tools"],
  oauth: boolean,
): ProviderOutputItem | undefined {
  if (block.type === "text") {
    block.data.text = block.text
    return { type: "assistant_message", text: block.text, replay: replay(block.data, target) }
  }
  if (block.type === "thinking") {
    if (block.data.type === "thinking") block.data.thinking = block.text
    return { type: "reasoning", summary: block.text, replay: replay(block.data, target) }
  }
  const callId = asString(block.data.id)
  const name = asString(block.data.name)
  if (!callId || !name) throw new Error("Anthropic tool call was incomplete")
  const input = block.partialJson
    ? parseToolArgs("Anthropic", name, block.partialJson)
    : isJsonObject(block.data.input)
      ? block.data.input
      : {}
  block.data.input = input
  return {
    type: "tool_call",
    callId,
    name: oauth ? xalToolName(name, tools) : name,
    args: input,
    replay: replay(block.data, target),
  }
}

export async function* streamResponse(request: StreamRequest): AsyncGenerator<StreamEvent> {
  const blocks = new Map<number, BlockState>()
  const target = { provider: PROVIDER_ID, model: request.model }
  let usage: Usage = {}
  let terminal = false
  try {
    const oauth = (await ensureAuth()).type === "oauth"
    const response = await anthropicFetch("/v1/messages", {
      method: "POST",
      headers: { accept: "text/event-stream" },
      body: buildBody(request, oauth),
      signal: request.signal,
    })
    if (!response.body) throw new ProviderError("Anthropic returned no response body", { retryable: true })

    for await (const frame of sseEvents(response.body)) {
      if (frame.done) continue
      if (!isRecord(frame.data)) throw new Error("Anthropic stream event was invalid")
      const type = asString(frame.data.type)
      switch (type) {
        case "message_start": {
          const message = isRecord(frame.data.message) ? frame.data.message : undefined
          usage = usageFrom(message?.usage, usage)
          break
        }
        case "content_block_start": {
          const index = asNumber(frame.data.index)
          if (index === undefined || !Number.isInteger(index)) throw new Error("Anthropic content block had no index")
          const block = startBlock(frame.data)
          if (!block) break
          blocks.set(index, block)
          if (block.text) {
            yield block.type === "text"
              ? { type: "text_delta", text: block.text }
              : { type: "reasoning_summary_delta", text: block.text }
          }
          break
        }
        case "content_block_delta": {
          const index = asNumber(frame.data.index)
          const block = index === undefined ? undefined : blocks.get(index)
          if (!block || !isRecord(frame.data.delta)) throw new Error("Anthropic content block delta was invalid")
          const deltaType = asString(frame.data.delta.type)
          if (deltaType === "text_delta") {
            const text = asString(frame.data.delta.text)
            if (text === undefined || block.type !== "text") throw new Error("Anthropic text delta was invalid")
            block.text += text
            yield { type: "text_delta", text }
          } else if (deltaType === "thinking_delta") {
            const text = asString(frame.data.delta.thinking)
            if (text === undefined || block.type !== "thinking") throw new Error("Anthropic thinking delta was invalid")
            block.text += text
            yield { type: "reasoning_summary_delta", text }
          } else if (deltaType === "signature_delta") {
            const signature = asString(frame.data.delta.signature)
            if (signature === undefined || block.type !== "thinking") {
              throw new Error("Anthropic thinking signature delta was invalid")
            }
            block.data.signature = `${asString(block.data.signature) ?? ""}${signature}`
          } else if (deltaType === "input_json_delta") {
            const partial = asString(frame.data.delta.partial_json)
            if (partial === undefined || block.type !== "tool_use") {
              throw new Error("Anthropic tool input delta was invalid")
            }
            block.partialJson += partial
          }
          break
        }
        case "content_block_stop": {
          const index = asNumber(frame.data.index)
          if (index === undefined) throw new Error("Anthropic content block stopped without an index")
          const block = blocks.get(index)
          if (!block) throw new Error("Anthropic content block stopped without starting")
          blocks.delete(index)
          const item = finishBlock(block, target, request.tools, oauth)
          if (item) yield { type: "item_done", item }
          break
        }
        case "message_delta":
          handleStopReason(frame.data.delta)
          usage = usageFrom(frame.data.usage, usage)
          break
        case "message_stop":
          terminal = true
          yield { type: "done", usage }
          break
        case "error":
          throw failure(frame.data)
        case "ping":
        case undefined:
          break
      }
    }
  } catch (error) {
    streamError("Anthropic", error, request.signal)
  }
  if (!terminal) throw new ProviderError("Anthropic stream ended unexpectedly", { retryable: true })
}
