import { asNumber, asString, isJsonObject, isRecord, type JsonObject, type JsonValue } from "../../lib/json"
import { replayMatches, type ConversationTarget } from "../../providers/conversation"
import type { ConversationItem, ToolDefinition, Usage } from "../../providers/types"
import { PROVIDER_NAME } from "./api"

export type WirePart =
  | { kind: "text"; text: string; part: JsonObject }
  | { kind: "thought"; text: string; part: JsonObject }
  | { kind: "tool_call"; name: string; args: JsonObject; callId: string; part: JsonObject }

export interface WireChunk {
  parts: WirePart[]
  usage?: Usage
  finishReason?: string
  failure?: { message: string; retryable: boolean }
}

const TRANSIENT_FAILURE = /unavailable|overloaded|internal|deadline|exhausted|try again/i

let synthesizedCalls = 0

function toolCallId(raw: Record<string, unknown>, name: string): string {
  const provided = asString(raw.id)
  if (provided) return provided
  synthesizedCalls += 1
  return `${name}-${synthesizedCalls}`
}

function usageFrom(raw: unknown): Usage | undefined {
  if (!isRecord(raw)) return undefined
  const output = (asNumber(raw.candidatesTokenCount) ?? 0) + (asNumber(raw.thoughtsTokenCount) ?? 0)
  return {
    totalInputTokens: asNumber(raw.promptTokenCount),
    cacheReadInputTokens: asNumber(raw.cachedContentTokenCount),
    outputTokens: output,
  }
}

export function parseChunk(raw: unknown): WireChunk | undefined {
  if (!isRecord(raw)) return undefined

  if (isRecord(raw.error)) {
    const message = asString(raw.error.message) ?? `${PROVIDER_NAME} stream error`
    const status = asString(raw.error.status) ?? ""
    return { parts: [], failure: { message, retryable: TRANSIENT_FAILURE.test(`${status} ${message}`) } }
  }

  const usage = usageFrom(raw.usageMetadata)
  const candidates = raw.candidates
  if (!Array.isArray(candidates) || candidates.length === 0) return { parts: [], usage }
  const candidate = candidates[0]
  if (!isRecord(candidate)) return { parts: [], usage }

  const finishReason = asString(candidate.finishReason)
  const content = candidate.content
  if (!isRecord(content) || !Array.isArray(content.parts)) return { parts: [], usage, finishReason }

  const parts: WirePart[] = []
  for (const entry of content.parts) {
    if (!isJsonObject(entry)) continue
    if (isRecord(entry.functionCall)) {
      const call = entry.functionCall
      const name = asString(call.name)
      if (!name) throw new Error(`${PROVIDER_NAME} function call had no name`)
      const args = isJsonObject(call.args) ? call.args : {}
      parts.push({ kind: "tool_call", name, args, callId: toolCallId(call, name), part: entry })
      continue
    }
    const text = asString(entry.text)
    if (text === undefined) continue
    parts.push({ kind: entry.thought === true ? "thought" : "text", text, part: entry })
  }
  return { parts, usage, finishReason }
}

export interface WireFunctionDeclaration {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export function buildTools(tools: ToolDefinition[]): { functionDeclarations: WireFunctionDeclaration[] }[] {
  return [
    {
      functionDeclarations: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      })),
    },
  ]
}

function imageParts(images: { mediaType: string; data: string }[]): JsonObject[] {
  return images.map((image) => ({ inlineData: { mimeType: image.mediaType, data: image.data } }))
}

function replayPart(
  item: { replay?: { provider: string; model?: string; data: JsonObject } },
  target: ConversationTarget,
): JsonObject | undefined {
  return replayMatches(item.replay, target) ? item.replay.data : undefined
}

export function buildContents(items: ConversationItem[], target: ConversationTarget): JsonObject[] {
  const contents: JsonObject[] = []
  const calls = new Map<string, { name: string; id?: string }>()
  let model: JsonObject[] = []

  for (const item of items) {
    if (item.type !== "tool_call") continue
    const data = replayPart(item, target)
    const call = data && isRecord(data.functionCall) ? data.functionCall : undefined
    const id = call ? asString(call.id) : undefined
    calls.set(item.callId, { name: item.name, ...(id ? { id } : {}) })
  }

  const flushModel = (): void => {
    if (model.length === 0) return
    contents.push({ role: "model", parts: model })
    model = []
  }

  const pushUser = (parts: JsonObject[]): void => {
    const last = contents.at(-1)
    if (last && Array.isArray(last.parts) && last.role === "user") {
      last.parts = [...last.parts, ...parts]
      return
    }
    contents.push({ role: "user", parts })
  }

  for (const item of items) {
    switch (item.type) {
      case "user_message": {
        flushModel()
        const text = item.modelText ?? item.text
        const parts = [...imageParts(item.images), ...(text ? [{ text }] : [])]
        pushUser(parts.length > 0 ? parts : [{ text: "" }])
        break
      }
      case "reasoning": {
        const part = replayPart(item, target)
        if (part) model.push(part)
        break
      }
      case "assistant_message": {
        const part = replayPart(item, target)
        if (part) model.push(part)
        else if (item.text) model.push({ text: item.text })
        break
      }
      case "tool_call": {
        const part = replayPart(item, target)
        model.push(part ?? { functionCall: { name: item.name, args: item.args } })
        break
      }
      case "tool_result": {
        flushModel()
        const call = calls.get(item.callId)
        const output: JsonValue = item.output
        pushUser([
          {
            functionResponse: {
              name: call?.name ?? item.callId,
              response: { output },
              ...(call?.id ? { id: call.id } : {}),
            },
          },
        ])
        break
      }
    }
  }

  flushModel()
  return contents
}
