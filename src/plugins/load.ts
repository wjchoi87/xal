import { isAbsolute, join, resolve } from "node:path"
import { isRecord } from "../lib/json"
import type { Plugin, PluginContext } from "./types"

function resolveSpec(spec: string, baseDir: string): string {
  if (spec.startsWith(".")) return join(resolve(baseDir, spec), "plugin.ts")
  if (isAbsolute(spec)) return join(spec, "plugin.ts")
  return spec
}

function isPromiseLike(value: unknown): boolean {
  return isRecord(value) && typeof value.then === "function"
}

export async function importPlugin(spec: string, baseDir: string): Promise<Plugin> {
  const mod: unknown = await import(resolveSpec(spec, baseDir))
  if (!isRecord(mod) || !isRecord(mod.default)) {
    throw new Error("plugin must default-export an object")
  }
  const candidate = mod.default
  const name = candidate.name
  const register = candidate.register
  const bootstrap = candidate.bootstrap
  if (typeof name !== "string" || typeof register !== "function") {
    throw new Error("plugin must have a name and a register function")
  }
  if (bootstrap !== undefined && typeof bootstrap !== "function") {
    throw new Error("plugin bootstrap must be a function")
  }
  const plugin: Plugin = {
    name,
    register(ctx: PluginContext) {
      const result: unknown = register.call(candidate, ctx)
      if (!isPromiseLike(result)) return
      void Promise.resolve(result).catch(() => {})
      throw new Error("plugin register must be synchronous; use bootstrap for asynchronous work")
    },
  }
  if (typeof bootstrap === "function") {
    plugin.bootstrap = async (ctx: PluginContext) => {
      await bootstrap.call(candidate, ctx)
    }
  }
  return plugin
}
