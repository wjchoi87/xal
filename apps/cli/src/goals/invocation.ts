const CLEAR_ALIASES = new Set(["clear", "stop", "off", "reset", "none", "cancel"])

export type GoalInvocation = { type: "status" } | { type: "clear" } | { type: "set"; condition: string }

function setInvocation(condition: string): GoalInvocation {
  if (!condition) throw new Error("goal condition must not be empty")
  if (Array.from(condition).length > 4_000) throw new Error("goal condition must be at most 4,000 characters")
  return { type: "set", condition }
}

export function parseGoalArguments(args: string[]): GoalInvocation {
  if (args.length === 0) return { type: "status" }
  const first = args[0]!
  if (CLEAR_ALIASES.has(first)) {
    if (args.length !== 1) throw new Error("usage: /goal [condition|clear]")
    return { type: "clear" }
  }
  return setInvocation(args.join(" ").trim())
}

export function parseGoalPrompt(prompt: string): GoalInvocation | undefined {
  const trimmed = prompt.trim()
  if (!/^\/goal(?:\s|$)/u.test(trimmed)) return undefined
  const remainder = trimmed.slice("/goal".length).trim()
  if (!remainder) return { type: "status" }
  const first = remainder.split(/\s/, 1)[0]!
  if (CLEAR_ALIASES.has(first)) {
    if (remainder !== first) throw new Error("usage: /goal [condition|clear]")
    return { type: "clear" }
  }
  return setInvocation(remainder)
}
