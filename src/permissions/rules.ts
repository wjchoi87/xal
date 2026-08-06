import { loadProjectRules, saveProjectRule } from "./store"
import type { PermissionRequest, PermissionRules, PermissionScope, PolicyDecision } from "./types"

interface Matcher {
  tool: string
  pattern: RegExp | undefined
}

interface Entry extends Matcher {
  decision: "allow" | "ask"
}

const RULE = /^([^()]+?)(?:\((.*)\))?$/

const defaults: Entry[] = []
let config: Entry[] = []
const project: Entry[] = []
const session: Entry[] = []
let denies: Matcher[] = []
let loaded: Promise<void> | undefined

function projectKey(): string {
  return process.cwd()
}

function toRegExp(pattern: string): RegExp {
  const source = pattern.replace(/[.*+?^${}()|[\]\\]/g, (char) => (char === "*" ? "[\\s\\S]*" : `\\${char}`))
  return new RegExp(`^${source}$`)
}

function parseMatcher(rule: string): Matcher | undefined {
  const match = RULE.exec(rule.trim())
  if (!match) return undefined
  const tool = match[1]!.trim()
  if (!tool) return undefined
  return { tool, pattern: match[2] === undefined ? undefined : toRegExp(match[2]) }
}

function toEntries(patterns: string[] | undefined, decision: "allow" | "ask"): Entry[] {
  if (!patterns) return []
  return patterns.flatMap((rule) => {
    const matcher = parseMatcher(rule)
    return matcher ? [{ ...matcher, decision }] : []
  })
}

function toMatchers(patterns: string[] | undefined): Matcher[] {
  if (!patterns) return []
  return patterns.flatMap((rule) => {
    const matcher = parseMatcher(rule)
    return matcher ? [matcher] : []
  })
}

function matches(matcher: Matcher, request: PermissionRequest): boolean {
  if (matcher.tool !== request.tool) return false
  if (!matcher.pattern) return true
  return request.subject !== undefined && matcher.pattern.test(request.subject)
}

export function contributeRules(rules: PermissionRules): void {
  defaults.push(...toEntries(rules.allow, "allow"), ...toEntries(rules.ask, "ask"))
}

export function setUserRules(rules: PermissionRules): void {
  config = [...toEntries(rules.allow, "allow"), ...toEntries(rules.ask, "ask")]
  denies = toMatchers(rules.deny)
}

export async function loadRememberedRules(): Promise<void> {
  loaded ??= loadProjectRules(projectKey()).then((patterns) => {
    project.push(...toEntries(patterns, "allow"))
  })
  await loaded
}

export function rememberRule(pattern: string, scope: PermissionScope): Promise<void> {
  const entries = toEntries([pattern], "allow")
  if (entries.length === 0) return Promise.resolve()
  session.push(...entries)
  if (scope !== "always") return Promise.resolve()
  return saveProjectRule(projectKey(), pattern)
}

export function isDenied(request: PermissionRequest): boolean {
  return denies.some((matcher) => matches(matcher, request))
}

export function matchRules(request: PermissionRequest): PolicyDecision | undefined {
  const entries = [...defaults, ...config, ...project, ...session]
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!
    if (matches(entry, request)) return entry.decision
  }
  return undefined
}
