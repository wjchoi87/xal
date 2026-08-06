import type { DenialCause } from "../../../agent/events"

export interface BannerBlock {
  kind: "banner"
  model: string
  cwd: string
}

export interface UserBlock {
  kind: "user"
  text: string
  sentAt: number
}

export interface InfoBlock {
  kind: "info"
  text: string
}

export interface ErrorBlock {
  kind: "error"
  text: string
}

export interface NoticeBlock {
  kind: "notice"
  summary: string
  details: string[]
}

export interface TextBlock {
  kind: "text"
  text: string
}

export interface ReasoningBlock {
  kind: "reasoning"
  text: string
}

export interface ToolBlock {
  kind: "tool"
  tool: string
  title: string
  readOnly: boolean
  denial: DenialCause | undefined
  output: string
  elapsed: string | undefined
}

export type StreamBlock = TextBlock | ReasoningBlock

export type StreamKind = StreamBlock["kind"]

export type Block = BannerBlock | UserBlock | InfoBlock | ErrorBlock | NoticeBlock | StreamBlock | ToolBlock
