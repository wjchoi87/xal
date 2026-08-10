import { registerPrompt } from "../agent/prompt"
import { registerCli } from "../cli/registry"
import { registerCommand } from "../commands/registry"
import { agentHome } from "../config/paths"
import type { Settings } from "../config/settings"
import { events, type PluginFailure, type PluginStatus } from "../events"
import { describeError } from "../lib/error"
import { contributeRules } from "../permissions/rules"
import { registerPolicyRule } from "../permissions/service"
import { registerProvider } from "../providers/registry"
import { registerTool } from "../tools/registry"
import { registerToolRenderer } from "../ui/extension"
import { registerUi } from "../ui/registry"
import { builtinPlugins } from "./builtins"
import { importPlugin } from "./load"
import type { Plugin, PluginContext } from "./types"

interface RegisteredPlugin {
  plugin: Plugin
  ctx: PluginContext
}

let status: PluginStatus = { total: 0, failures: [] }
let registered: RegisteredPlugin[] = []
let bootstrapRun: Promise<PluginStatus> | undefined

function contextFor(plugin: Plugin, settings: Settings): PluginContext {
  return {
    config: settings.pluginConfig[plugin.name] ?? {},
    events,
    registerTool,
    registerProvider,
    registerCli,
    registerCommand,
    registerPrompt,
    registerPolicyRule,
    registerPermissionRules: contributeRules,
    registerUi,
    registerToolRenderer,
  }
}

function registerPlugin(plugin: Plugin, settings: Settings): RegisteredPlugin {
  const ctx = contextFor(plugin, settings)
  plugin.register(ctx)
  return { plugin, ctx }
}

export async function registerPlugins(settings: Settings): Promise<PluginStatus> {
  const failures: PluginFailure[] = []
  registered = []
  bootstrapRun = undefined

  for (const plugin of builtinPlugins) {
    try {
      registered.push(registerPlugin(plugin, settings))
    } catch (error) {
      failures.push({ plugin: plugin.name, phase: "register", reason: describeError(error) })
    }
  }

  for (const spec of settings.plugins) {
    try {
      const plugin = await importPlugin(spec, agentHome())
      registered.push(registerPlugin(plugin, settings))
    } catch (error) {
      failures.push({ plugin: spec, phase: "register", reason: describeError(error) })
    }
  }

  status = { total: builtinPlugins.length + settings.plugins.length, failures }
  events.emitRetained({ type: "plugin_registration_finished", status })
  return status
}

async function runBootstrap(): Promise<PluginStatus> {
  const entries = registered.filter((entry) => entry.plugin.bootstrap)
  events.emitRetained({ type: "plugin_bootstrap_started", total: entries.length })
  const outcomes = await Promise.allSettled(
    entries.map((entry) => Promise.resolve().then(() => entry.plugin.bootstrap?.(entry.ctx))),
  )
  const failures = outcomes.flatMap((outcome, index): PluginFailure[] => {
    if (outcome.status === "fulfilled") return []
    return [{ plugin: entries[index]!.plugin.name, phase: "bootstrap", reason: describeError(outcome.reason) }]
  })
  status = { total: status.total, failures: [...status.failures, ...failures] }
  events.emitRetained({ type: "plugin_bootstrap_finished", status })
  return status
}

export function bootstrapPlugins(): Promise<PluginStatus> {
  bootstrapRun ??= runBootstrap()
  return bootstrapRun
}
