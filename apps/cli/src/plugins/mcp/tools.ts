import { asString, isRecord } from "../../lib/json"
import type { Tool } from "../../tools/types"
import type { McpManager } from "./manager"

function requiredString(args: Record<string, unknown>, name: string): string {
  const value = asString(args[name])
  if (!value) throw new Error(`${name} is required`)
  return value
}

function promptArguments(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) throw new Error("arguments must be an object of string values")
  const result: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") throw new Error("arguments must be an object of string values")
    result[key] = entry
  }
  return result
}

export function mcpTools(manager: McpManager): Tool[] {
  return [
    {
      name: "mcp_resources",
      description:
        "List resources and resource templates exposed by connected MCP servers. Optionally limit the catalog to one configured server.",
      parameters: {
        type: "object",
        properties: {
          server: { type: "string", description: "Configured MCP server name" },
        },
        additionalProperties: false,
      },
      available: () => manager.hasResources(),
      title: (args) => asString(args.server) ?? "all MCP servers",
      readOnly: () => true,
      concurrency: () => "shared",
      async execute(args) {
        return { output: manager.resourceCatalog(asString(args.server)) }
      },
    },
    {
      name: "mcp_read_resource",
      description: "Read a resource from a connected MCP server using its exact URI.",
      parameters: {
        type: "object",
        properties: {
          server: { type: "string", description: "Configured MCP server name" },
          uri: { type: "string", description: "Resource URI or a URI resolved from a listed template" },
        },
        required: ["server", "uri"],
        additionalProperties: false,
      },
      available: () => manager.hasResources(),
      title: (args) => `${asString(args.server) ?? "MCP"}: ${asString(args.uri) ?? "resource"}`,
      undo: () => ({ type: "invalidate" }),
      concurrency: () => "shared",
      permission: (args) => ({ subject: `${asString(args.server) ?? ""}/${asString(args.uri) ?? ""}` }),
      async execute(args, ctx) {
        const server = requiredString(args, "server")
        const uri = requiredString(args, "uri")
        return { output: await manager.readResource(server, uri, ctx.signal) }
      },
    },
    {
      name: "mcp_prompts",
      description:
        "List reusable prompts exposed by connected MCP servers, including their argument names. Optionally limit the catalog to one server.",
      parameters: {
        type: "object",
        properties: {
          server: { type: "string", description: "Configured MCP server name" },
        },
        additionalProperties: false,
      },
      available: () => manager.hasPrompts(),
      title: (args) => asString(args.server) ?? "all MCP servers",
      readOnly: () => true,
      concurrency: () => "shared",
      async execute(args) {
        return { output: manager.promptCatalog(asString(args.server)) }
      },
    },
    {
      name: "mcp_get_prompt",
      description: "Load a reusable prompt from a connected MCP server with optional string arguments.",
      parameters: {
        type: "object",
        properties: {
          server: { type: "string", description: "Configured MCP server name" },
          name: { type: "string", description: "Prompt name from mcp_prompts" },
          arguments: {
            type: "object",
            description: "Prompt arguments as string values",
            additionalProperties: { type: "string" },
          },
        },
        required: ["server", "name"],
        additionalProperties: false,
      },
      available: () => manager.hasPrompts(),
      title: (args) => `${asString(args.server) ?? "MCP"}: ${asString(args.name) ?? "prompt"}`,
      undo: () => ({ type: "invalidate" }),
      concurrency: () => "shared",
      permission: (args) => ({ subject: `${asString(args.server) ?? ""}/${asString(args.name) ?? ""}` }),
      async execute(args, ctx) {
        const server = requiredString(args, "server")
        const name = requiredString(args, "name")
        return { output: await manager.getPrompt(server, name, promptArguments(args.arguments), ctx.signal) }
      },
    },
  ]
}
