import type { PromptSection } from "../agent/prompt"
import type { Command } from "../commands/registry"
import type { EventService } from "../events"
import type { PolicyRule } from "../permissions/service"
import type { Provider } from "../providers/types"
import type { Tool } from "../tools/types"
import type { ThemeColors, ToolRenderer } from "../ui/extension"
import type { Ui } from "../ui/registry"

export interface Plugin {
  name: string
  register(ctx: PluginContext): void
  bootstrap?(ctx: PluginContext): Promise<void>
}

export interface PluginContext {
  config: Record<string, unknown>
  events: EventService
  registerTool(tool: Tool): void
  registerProvider(provider: Provider): void
  registerCommand(command: Command): void
  registerPrompt(section: PromptSection): void
  registerPromptFull(section: PromptSection): void
  registerPolicyRule(rule: PolicyRule): void
  registerUi(ui: Ui): void
  registerToolRenderer(renderer: ToolRenderer): void
  setTheme(overrides: Partial<ThemeColors>): void
}
