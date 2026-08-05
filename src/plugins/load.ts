import { isAbsolute, join, resolve } from "node:path"
import { isRecord } from "../lib/json"
import type { Plugin, PluginContext } from "./types"

function resolveSpec(spec: string, baseDir: string): string {
  if (spec.startsWith(".")) return join(resolve(baseDir, spec), "plugin.ts")
  if (isAbsolute(spec)) return join(spec, "plugin.ts")
  return spec
}

export async function importPlugin(spec: string, baseDir: string): Promise<Plugin> {
  const mod: unknown = await import(resolveSpec(spec, baseDir))
  if (!isRecord(mod) || !isRecord(mod.default)) {
    throw new Error("plugin must default-export an object")
  }
  const candidate = mod.default
  const name = candidate.name
  const register = candidate.register
  if (typeof name !== "string" || typeof register !== "function") {
    throw new Error("plugin must have a name and a register function")
  }
  return {
    name,
    register(ctx: PluginContext) {
      register.call(candidate, ctx)
    },
  }
}
