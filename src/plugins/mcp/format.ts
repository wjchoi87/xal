import type { Client } from "@modelcontextprotocol/sdk/client/index.js"
import type { ContentBlock } from "@modelcontextprotocol/sdk/types.js"

type FormattableResource =
  { uri: string; text: string; mimeType?: string } | { uri: string; blob: string; mimeType?: string }

function json(value: unknown): string {
  return JSON.stringify(value, undefined, 2) ?? String(value)
}

function binary(label: string, mimeType: string | undefined, data: string): string {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0
  const size = Math.max(0, Math.floor((data.length * 3) / 4) - padding)
  return `[${label}: ${mimeType ?? "unknown type"}, ${size} bytes omitted]`
}

export function formatContentBlock(block: ContentBlock): string {
  switch (block.type) {
    case "text":
      return block.text
    case "image":
      return binary("image", block.mimeType, block.data)
    case "audio":
      return binary("audio", block.mimeType, block.data)
    case "resource_link":
      return `[resource ${block.name}: ${block.uri}]`
    case "resource":
      return formatResourceContent(block.resource)
  }
}

export function formatResourceContent(content: FormattableResource): string {
  if ("text" in content) return `[resource ${content.uri}]\n${content.text}`
  return `[resource ${content.uri}]\n${binary("binary resource", content.mimeType, content.blob)}`
}

export function formatToolResult(result: Awaited<ReturnType<Client["callTool"]>>): string {
  if ("toolResult" in result) return json(result.toolResult)
  const sections = result.content.map(formatContentBlock)
  if (result.structuredContent) sections.push(`Structured content:\n${json(result.structuredContent)}`)
  const output = sections.filter((section) => section.length > 0).join("\n\n") || "(empty MCP tool result)"
  return result.isError ? `MCP tool returned an error.\n\n${output}` : output
}

export function formatPromptResult(result: Awaited<ReturnType<Client["getPrompt"]>>): string {
  const sections = result.messages.map((message) => `${message.role}:\n${formatContentBlock(message.content)}`)
  if (result.description) sections.unshift(result.description)
  return sections.join("\n\n") || "(empty MCP prompt)"
}

export function formatJson(value: unknown): string {
  return json(value)
}
