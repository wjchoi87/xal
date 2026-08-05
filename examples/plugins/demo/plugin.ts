import { RGBA } from "@opentui/core"
import type { Plugin } from "../../../src/plugins/types"

const plugin: Plugin = {
  name: "demo",
  register(ctx) {
    ctx.registerCommand({
      name: "hello",
      describe: "print a greeting from the demo plugin",
      async run(args, cmd) {
        cmd.print(`hello from the demo plugin${args.length > 0 ? `: ${args.join(" ")}` : ""}`)
      },
    })
    ctx.registerPromptFull({
      id: "identity",
      text: (prompt) =>
        `You are ${prompt.appName}, a coding agent running in the user's terminal. The demo plugin has replaced your identity section.`,
    })
    ctx.registerPrompt({
      id: "conduct",
      text: () => "The demo plugin appended this line to your conduct section.",
    })
    ctx.registerTool({
      name: "echo",
      description: "Echo the given text back to the conversation.",
      parameters: {
        type: "object",
        properties: {
          text: {
            type: "string",
            description: "The text to echo",
          },
        },
        required: ["text"],
        additionalProperties: false,
      },
      title: (args) => String(args.text ?? ""),
      readOnly: () => true,
      async execute(args) {
        return { output: String(args.text ?? "") }
      },
    })
    ctx.registerPolicyRule({
      id: "allow-read-only",
      evaluate: (request) => (request.readOnly ? "allow" : undefined),
    })
    ctx.registerToolRenderer({
      tool: "echo",
      waitingLabel: () => "Waiting for echo",
      summarize: (output) => `echoed ${output.length} chars`,
    })
    ctx.setTheme({ accent: RGBA.fromIndex(10) })
  },
}

export default plugin
