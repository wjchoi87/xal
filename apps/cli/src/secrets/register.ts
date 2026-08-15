import type { Settings } from "../config/settings"
import { replaceSecretValues } from "./redactor"

export function registerRedaction(settings: Settings): void {
  const environment = settings.redaction.environment.flatMap((name) => {
    const value = process.env[name]
    return value ? [value] : []
  })
  replaceSecretValues("redaction", [...settings.redaction.values, ...environment])
}
