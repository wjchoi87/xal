import { registerPrompt, registerPromptFull } from "../agent/prompt"
import { registerCommand } from "../commands/registry"
import { configDir } from "../config/paths"
import type { Settings } from "../config/settings"
import { registerPolicyRule } from "../permissions/service"
import { registerProvider } from "../providers/registry"
import { registerTool } from "../tools/registry"
import { registerToolRenderer, setTheme } from "../ui/extension"
import { registerUi } from "../ui/registry"
import { builtinPlugins } from "./builtins"
import { importPlugin } from "./load"
import type { Plugin, PluginContext } from "./types"

export interface PluginFailure {
  plugin: string
  reason: string
}

export interface PluginStatus {
  total: number
  failures: PluginFailure[]
}

let status: PluginStatus = { total: 0, failures: [] }

export function pluginStatus(): PluginStatus {
  return status
}

function contextFor(plugin: Plugin, settings: Settings): PluginContext {
  return {
    config: settings.pluginConfig[plugin.name] ?? {},
    registerTool,
    registerProvider,
    registerCommand,
    registerPrompt,
    registerPromptFull,
    registerPolicyRule,
    registerUi,
    registerToolRenderer,
    setTheme,
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function registerPlugins(settings: Settings): Promise<PluginStatus> {
  const failures: PluginFailure[] = []

  for (const plugin of builtinPlugins) {
    try {
      plugin.register(contextFor(plugin, settings))
    } catch (error) {
      failures.push({ plugin: plugin.name, reason: describeError(error) })
    }
  }

  for (const spec of settings.plugins) {
    try {
      const plugin = await importPlugin(spec, configDir())
      plugin.register(contextFor(plugin, settings))
    } catch (error) {
      failures.push({ plugin: spec, reason: describeError(error) })
    }
  }

  status = { total: builtinPlugins.length + settings.plugins.length, failures }
  return status
}
