import pkg from "xal/package.json"

export const appInfo = {
  name: pkg.name,
  version: pkg.version,
} as const
