import { builtinClis } from "./builtins"
import type { Cli, ResolvedCli } from "./types"

const clis = new Map<string, Cli>(builtinClis.map((cli) => [cli.name, cli]))
const children = new Map<string, Map<string, Cli>>()

export function registerCli(cli: Cli, parent?: string): void {
  if (!parent) {
    clis.set(cli.name, cli)
    return
  }
  if (!clis.has(parent)) throw new Error(`unknown parent cli: ${parent}`)
  const group = children.get(parent) ?? new Map<string, Cli>()
  group.set(cli.name, cli)
  children.set(parent, group)
}

export function listClis(parent?: string): Cli[] {
  if (!parent) return [...clis.values()]
  return [...(children.get(parent)?.values() ?? [])]
}

export function resolveCli(args: string[]): ResolvedCli | undefined {
  const name = args[0]
  if (!name) return undefined

  const cli = clis.get(name)
  if (!cli) return undefined

  const subName = args[1]
  if (subName) {
    const sub = children.get(name)?.get(subName)
    if (sub) return { cli: sub, args: args.slice(2) }
  }

  return { cli, args: args.slice(1) }
}
