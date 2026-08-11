import type { PromptSection } from "../agent/prompt"
import type { Cli } from "../cli/types"
import type { Command } from "../commands/types"
import type { EventService } from "../events"
import type { Hook } from "../hooks/types"
import type { PermissionRules, PolicyRule } from "../permissions/types"
import type { Provider } from "../providers/types"
import type { RegisteredTool } from "../tools/types"
import type { ToolRenderer } from "../ui/extension"
import type { Ui } from "../ui/registry"

export interface Plugin {
  name: string
  register(ctx: PluginContext): void
  bootstrap?(ctx: PluginContext): Promise<void>
  shutdown?(ctx: PluginContext): Promise<void>
}

export interface PluginContext {
  config: Record<string, unknown>
  events: EventService
  signal: AbortSignal
  registerTool(tool: RegisteredTool): void
  unregisterTool(tool: RegisteredTool): void
  registerProvider(provider: Provider): void
  registerCli(cli: Cli, parent?: string): void
  registerCommand(command: Command): void
  registerHook(hook: Hook): void
  registerPrompt(section: PromptSection): void
  registerPolicyRule(rule: PolicyRule): void
  registerPermissionRules(rules: PermissionRules): void
  registerSecrets(values: string[]): void
  registerUi(ui: Ui): void
  registerToolRenderer(renderer: ToolRenderer): void
}
