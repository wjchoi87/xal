import type { JsonObject } from "../lib/json"

export interface ProviderReplay {
  provider: string
  model?: string
  data: JsonObject
}

export interface ImageInput {
  mediaType: "image/png" | "image/jpeg"
  data: string
}

export interface UserInput {
  text: string
  images: ImageInput[]
}

export interface UserMessageItem extends UserInput {
  type: "user_message"
  messageId?: string
  modelText?: string
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
  output: string
}

export type ProviderOutputItem = AssistantMessageItem | ReasoningItem | ToolCallItem

export type ConversationItem = UserMessageItem | ProviderOutputItem | ToolResultItem

export interface ModelInfo {
  id: string
  name: string
  contextWindow?: number
  inputModalities: ModelInputModality[]
  thinking?: ThinkingOptions
}

export type ModelInputModality = "text" | "image"

export type ModelCatalogSource = "runtime" | "cache" | "bundled"

export interface ModelCatalog {
  models: ModelInfo[]
  source: ModelCatalogSource
  warning?: string
}

export interface Usage {
  totalInputTokens?: number
  cacheReadInputTokens?: number
  cacheWriteInputTokens?: number
  outputTokens?: number
}

export function occupiedContext(usage: Usage): number {
  return (usage.totalInputTokens ?? 0) + (usage.outputTokens ?? 0)
}

export type ThinkingEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max"

export function isThinkingEffort(value: unknown): value is ThinkingEffort {
  return (
    value === "none" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh" ||
    value === "max"
  )
}

export interface ThinkingOptions {
  options: ThinkingEffort[]
  default: ThinkingEffort
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
  thinking?: ThinkingEffort
  instructions: string
  input: ConversationItem[]
  tools: ToolDefinition[]
  sessionId: string
  signal?: AbortSignal
}

export interface ConnectContext {
  print(line: string): void
  ask?(question: string): Promise<string>
  askSecret?(question: string): Promise<string | undefined>
}

export interface Provider {
  id: string
  name: string
  aliases: string[]
  capabilities: { imageInput: boolean }
  isLoggedIn(): Promise<boolean>
  connect?(ctx: ConnectContext): Promise<boolean>
  listModels(refresh: boolean): Promise<ModelCatalog>
  defaultModel(): Promise<string>
  stream(request: StreamRequest): AsyncIterable<StreamEvent>
}
