import { asNumber, asString, isRecord } from "../lib/json"
import type { Usage } from "../providers/types"

export type GoalVerdict =
  | { verdict: "not_yet_met"; reason: string }
  | { verdict: "met"; reason: string }
  | { verdict: "impossible"; reason: string }

export type GoalSuspensionCause =
  "interruption" | "turn_failure" | "evaluator_failure" | "no_progress" | "history_movement"

export interface GoalMetrics {
  id: string
  condition: string
  startedAt: number
  evaluatedTurns: number
  usage: Usage
  evaluatorModel: string
  lastReason?: string
  consecutiveNoToolTurns: number
}

export type GoalSnapshot =
  | (GoalMetrics & { status: "active" })
  | (GoalMetrics & { status: "suspended"; suspendedAt: number; suspensionCause: GoalSuspensionCause })
  | (GoalMetrics & { status: "achieved"; endedAt: number; lastReason: string })
  | (GoalMetrics & { status: "impossible"; endedAt: number; lastReason: string })
  | (GoalMetrics & { status: "cleared"; endedAt: number })

const METRIC_KEYS = [
  "status",
  "id",
  "condition",
  "startedAt",
  "evaluatedTurns",
  "usage",
  "evaluatorModel",
  "lastReason",
  "consecutiveNoToolTurns",
]

function hasOnlyKeys(raw: Record<string, unknown>, keys: string[]): boolean {
  const allowed = new Set(keys)
  return Object.keys(raw).every((key) => allowed.has(key))
}

function nonNegativeInteger(value: unknown): number | undefined {
  const number = asNumber(value)
  return number !== undefined && Number.isSafeInteger(number) && number >= 0 ? number : undefined
}

function parseUsage(raw: unknown): Usage | undefined {
  if (
    !isRecord(raw) ||
    !hasOnlyKeys(raw, ["totalInputTokens", "cacheReadInputTokens", "cacheWriteInputTokens", "outputTokens"])
  ) {
    return undefined
  }
  const totalInputTokens = nonNegativeInteger(raw.totalInputTokens)
  const cacheReadInputTokens = nonNegativeInteger(raw.cacheReadInputTokens)
  const cacheWriteInputTokens = nonNegativeInteger(raw.cacheWriteInputTokens)
  const outputTokens = nonNegativeInteger(raw.outputTokens)
  if (
    (raw.totalInputTokens !== undefined && totalInputTokens === undefined) ||
    (raw.cacheReadInputTokens !== undefined && cacheReadInputTokens === undefined) ||
    (raw.cacheWriteInputTokens !== undefined && cacheWriteInputTokens === undefined) ||
    (raw.outputTokens !== undefined && outputTokens === undefined)
  ) {
    return undefined
  }
  return {
    ...(totalInputTokens === undefined ? {} : { totalInputTokens }),
    ...(cacheReadInputTokens === undefined ? {} : { cacheReadInputTokens }),
    ...(cacheWriteInputTokens === undefined ? {} : { cacheWriteInputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
  }
}

function nonEmptyString(value: unknown): string | undefined {
  const text = asString(value)
  return text?.trim() ? text : undefined
}

export function goalConditionError(condition: string): string | undefined {
  if (!condition.trim()) return "Goal condition must not be empty"
  if ([...condition].length > 4_000) return "Goal condition must contain at most 4,000 characters"
  return undefined
}

export function parseGoalVerdict(raw: unknown): GoalVerdict | undefined {
  if (!isRecord(raw) || !hasOnlyKeys(raw, ["verdict", "reason"])) return undefined
  const verdict = asString(raw.verdict)
  const reason = nonEmptyString(raw.reason)
  if (!reason) return undefined
  if (verdict === "not_yet_met" || verdict === "met" || verdict === "impossible") return { verdict, reason }
  return undefined
}

function parseMetrics(raw: Record<string, unknown>): GoalMetrics | undefined {
  const id = nonEmptyString(raw.id)
  const condition = asString(raw.condition)
  const startedAt = nonNegativeInteger(raw.startedAt)
  const evaluatedTurns = nonNegativeInteger(raw.evaluatedTurns)
  const usage = parseUsage(raw.usage)
  const evaluatorModel = nonEmptyString(raw.evaluatorModel)
  const lastReason = raw.lastReason === undefined ? undefined : nonEmptyString(raw.lastReason)
  const consecutiveNoToolTurns = nonNegativeInteger(raw.consecutiveNoToolTurns)
  if (
    !id ||
    condition === undefined ||
    goalConditionError(condition) !== undefined ||
    startedAt === undefined ||
    evaluatedTurns === undefined ||
    !usage ||
    !evaluatorModel ||
    (raw.lastReason !== undefined && !lastReason) ||
    consecutiveNoToolTurns === undefined ||
    consecutiveNoToolTurns > evaluatedTurns
  ) {
    return undefined
  }
  return {
    id,
    condition,
    startedAt,
    evaluatedTurns,
    usage,
    evaluatorModel,
    ...(lastReason === undefined ? {} : { lastReason }),
    consecutiveNoToolTurns,
  }
}

function suspensionCause(value: unknown): GoalSuspensionCause | undefined {
  const cause = asString(value)
  if (
    cause === "interruption" ||
    cause === "turn_failure" ||
    cause === "evaluator_failure" ||
    cause === "no_progress" ||
    cause === "history_movement"
  ) {
    return cause
  }
  return undefined
}

export function parseGoalSnapshot(raw: unknown): GoalSnapshot | undefined {
  if (!isRecord(raw)) return undefined
  const status = asString(raw.status)
  const terminal = status === "achieved" || status === "impossible" || status === "cleared"
  const allowedKeys =
    status === "suspended"
      ? [...METRIC_KEYS, "suspendedAt", "suspensionCause"]
      : terminal
        ? [...METRIC_KEYS, "endedAt"]
        : METRIC_KEYS
  if (!hasOnlyKeys(raw, allowedKeys)) return undefined
  const metrics = parseMetrics(raw)
  if (!metrics) return undefined
  if (status === "active") return { status, ...metrics }
  if (status === "suspended") {
    const suspendedAt = nonNegativeInteger(raw.suspendedAt)
    const cause = suspensionCause(raw.suspensionCause)
    return suspendedAt === undefined || suspendedAt < metrics.startedAt || !cause
      ? undefined
      : { status, ...metrics, suspendedAt, suspensionCause: cause }
  }
  if (status === "achieved" || status === "impossible") {
    const endedAt = nonNegativeInteger(raw.endedAt)
    const lastReason = nonEmptyString(raw.lastReason)
    return endedAt === undefined || endedAt < metrics.startedAt || !lastReason
      ? undefined
      : { status, ...metrics, endedAt, lastReason }
  }
  if (status === "cleared") {
    const endedAt = nonNegativeInteger(raw.endedAt)
    return endedAt === undefined || endedAt < metrics.startedAt ? undefined : { status, ...metrics, endedAt }
  }
  return undefined
}
