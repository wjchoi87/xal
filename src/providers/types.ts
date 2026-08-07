import type { JsonObject } from "../lib/json"

export interface ProviderReplay {
  provider: string
  model: string
  data: JsonObject
}

export interface UserMessageItem {
  type: "user_message"
  text: string
}

export interface AssistantMessageItem {
  type: "assistant_message"
  text: string
  replay?: ProviderReplay
}

export interface ReasoningItem {
  type: "reasoning"
  summary: string
  replay?: ProviderReplay
}

export interface ToolCallItem {
  type: "tool_call"
  callId: string
  name: string
  args: JsonObject
  replay?: ProviderReplay
}

export interface ToolResultItem {
  type: "tool_result"
  callId: string
  name: string
  output: string
  isError: boolean
}

export type ProviderOutputItem = AssistantMessageItem | ReasoningItem | ToolCallItem

export type ConversationItem = UserMessageItem | ProviderOutputItem | ToolResultItem

export interface ModelInfo {
  id: string
  name: string
  contextWindow?: number
  maxOutput?: number
  reasoning?: boolean
}

export interface Usage {
  totalInputTokens?: number
  cacheReadInputTokens?: number
  cacheWriteInputTokens?: number
  outputTokens?: number
}

export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export type StreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "reasoning_summary_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "item_done"; item: ProviderOutputItem }
  | { type: "done"; usage?: Usage }

export interface StreamRequest {
  model: string
  instructions: string
  input: ConversationItem[]
  tools: ToolDefinition[]
  sessionId: string
  signal?: AbortSignal
}

export interface ConnectContext {
  print(line: string): void
  ask?(question: string): Promise<string>
}

export interface Provider {
  id: string
  name: string
  aliases: string[]
  isLoggedIn(): Promise<boolean>
  connect?(ctx: ConnectContext): Promise<void>
  listModels(): Promise<ModelInfo[]>
  defaultModel(): Promise<string>
  stream(request: StreamRequest): AsyncIterable<StreamEvent>
}
