import pkg from "../package.json"

export const appInfo = {
  name: pkg.name,
  version: pkg.version,
} as const

export function appEnvVar(suffix: string): string {
  return `${appInfo.name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_${suffix}`
}
