export type ConversationItem = Record<string, unknown>

export interface ModelInfo {
  id: string
  name: string
  contextWindow?: number
  maxOutput?: number
  reasoning?: boolean
}

export interface Usage {
  inputTokens?: number
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
  | { type: "tool_call"; callId: string; name: string; args: Record<string, unknown> }
  | { type: "item_done"; item: ConversationItem }
  | { type: "done"; usage?: Usage }

export interface StreamRequest {
  model: string
  instructions: string
  input: ConversationItem[]
  tools: ToolDefinition[]
  sessionId: string
  signal?: AbortSignal
}

export interface Provider {
  id: string
  name: string
  aliases: string[]
  login(print: (line: string) => void): Promise<void>
  isLoggedIn(): Promise<boolean>
  listModels(): Promise<ModelInfo[]>
  defaultModel(): Promise<string>
  stream(request: StreamRequest): AsyncIterable<StreamEvent>
}
