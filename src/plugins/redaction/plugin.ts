import { asStringArray } from "../../lib/json"
import type { Plugin } from "../types"

function configured(values: unknown, field: string): string[] {
  if (values === undefined) return []
  if (!Array.isArray(values) || asStringArray(values).length !== values.length) {
    throw new Error(`redaction ${field} must be an array of strings`)
  }
  return asStringArray(values)
}

const plugin: Plugin = {
  name: "redaction",
  register(ctx) {
    const values = configured(ctx.config.values, "values")
    const environment = configured(ctx.config.environment, "environment").flatMap((name) => {
      const value = process.env[name]
      return value ? [value] : []
    })
    ctx.registerSecrets([...values, ...environment])
  },
}

export default plugin
