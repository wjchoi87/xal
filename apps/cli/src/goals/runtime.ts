import type { TurnSummary } from "../agent/session/turn"
import { addUsage, isAbortError } from "../agent/session/types"
import { describeError } from "../lib/error"
import type { Usage } from "../providers/types"
import { redactText } from "../secrets/redactor"
import type { GoalEvaluationContext, GoalEvaluationRequest, GoalEvaluationResult } from "./evaluator"
import { goalConditionError, type GoalMetrics, type GoalSnapshot, type GoalSuspensionCause } from "./types"

export type ActiveGoalSnapshot = Extract<GoalSnapshot, { status: "active" }>
export type SuspendedGoalSnapshot = Extract<GoalSnapshot, { status: "suspended" }>
export type AchievedGoalSnapshot = Extract<GoalSnapshot, { status: "achieved" }>
export type ImpossibleGoalSnapshot = Extract<GoalSnapshot, { status: "impossible" }>
export type ClearedGoalSnapshot = Extract<GoalSnapshot, { status: "cleared" }>

export interface GoalUpdatedEvent {
  type: "goal_updated"
  goal: GoalSnapshot
}

export type GoalEvaluationOutcome =
  | { status: "stale" }
  | { status: "continue"; goal: ActiveGoalSnapshot }
  | { status: "achieved"; goal: AchievedGoalSnapshot }
  | { status: "impossible"; goal: ImpossibleGoalSnapshot }
  | { status: "suspended"; goal: SuspendedGoalSnapshot }

export interface GoalRuntimeHost {
  emit(event: GoalUpdatedEvent): void
  evaluate(request: GoalEvaluationRequest): Promise<GoalEvaluationResult>
}

function emptyUsage(): Usage {
  return {
    totalInputTokens: 0,
    cacheReadInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
  }
}

function withUsage(total: Usage, ...entries: (Usage | undefined)[]): Usage {
  let usage = total
  for (const entry of entries) {
    if (entry) usage = addUsage(usage, entry)
  }
  return usage
}

function metrics(snapshot: GoalSnapshot): GoalMetrics {
  return {
    id: snapshot.id,
    condition: snapshot.condition,
    startedAt: snapshot.startedAt,
    evaluatedTurns: snapshot.evaluatedTurns,
    usage: snapshot.usage,
    evaluatorModel: snapshot.evaluatorModel,
    ...(snapshot.lastReason === undefined ? {} : { lastReason: snapshot.lastReason }),
    consecutiveNoToolTurns: snapshot.consecutiveNoToolTurns,
  }
}

export class GoalRuntime {
  private goal: GoalSnapshot | undefined

  constructor(private readonly host: GoalRuntimeHost) {}

  snapshot(): GoalSnapshot | undefined {
    return this.goal
  }

  active(goalId?: string): ActiveGoalSnapshot | undefined {
    if (this.goal?.status !== "active") return undefined
    if (goalId !== undefined && this.goal.id !== goalId) return undefined
    return this.goal
  }

  set(condition: string, evaluatorModel: string): ActiveGoalSnapshot {
    const redacted = redactText(condition)
    const error = goalConditionError(redacted)
    if (error) throw new Error(error)
    if (!evaluatorModel.trim()) throw new Error("Goal evaluator model must not be empty")
    return this.commit({
      status: "active",
      id: crypto.randomUUID(),
      condition: redacted,
      startedAt: Date.now(),
      evaluatedTurns: 0,
      usage: emptyUsage(),
      evaluatorModel,
      consecutiveNoToolTurns: 0,
    })
  }

  rearm(): ActiveGoalSnapshot | undefined {
    if (this.goal?.status !== "suspended") return undefined
    return this.commit({ status: "active", ...metrics(this.goal) })
  }

  suspend(goalId: string, cause: GoalSuspensionCause, reason?: string): SuspendedGoalSnapshot | undefined {
    const active = this.active(goalId)
    if (!active) return undefined
    return this.commit({
      ...active,
      status: "suspended",
      suspendedAt: Date.now(),
      suspensionCause: cause,
      ...(reason?.trim() ? { lastReason: redactText(reason) } : {}),
    })
  }

  suspendForHistoryMovement(): SuspendedGoalSnapshot | undefined {
    const active = this.active()
    return active ? this.suspend(active.id, "history_movement") : undefined
  }

  clear(): ClearedGoalSnapshot | undefined {
    if (this.goal?.status !== "active" && this.goal?.status !== "suspended") return undefined
    return this.commit({ status: "cleared", ...metrics(this.goal), endedAt: Date.now() })
  }

  reset(): void {
    this.goal = undefined
  }

  restore(snapshot: GoalSnapshot): void {
    this.goal = snapshot
  }

  resume(): ActiveGoalSnapshot | undefined {
    const active = this.active()
    if (!active) return undefined
    return this.commit({
      status: "active",
      id: active.id,
      condition: active.condition,
      startedAt: Date.now(),
      evaluatedTurns: 0,
      usage: emptyUsage(),
      evaluatorModel: active.evaluatorModel,
      consecutiveNoToolTurns: 0,
    })
  }

  async evaluate(goalId: string, context: GoalEvaluationContext, turn: TurnSummary): Promise<GoalEvaluationOutcome> {
    const active = this.active(goalId)
    if (!active) return { status: "stale" }
    let result: GoalEvaluationResult
    try {
      result = await this.host.evaluate({ ...context, condition: active.condition })
    } catch (error) {
      if (!this.active(goalId)) return { status: "stale" }
      const cause = context.signal.aborted || isAbortError(error) ? "interruption" : "evaluator_failure"
      const reason = redactText(describeError(error))
      this.commit({
        ...active,
        status: "suspended",
        suspendedAt: Date.now(),
        suspensionCause: cause,
        usage: withUsage(active.usage, turn.usage.turn),
        lastReason: reason,
      })
      throw error
    }
    const current = this.active(goalId)
    if (!current) return { status: "stale" }
    const usage = withUsage(current.usage, turn.usage.turn, result.usage)
    const evaluatedTurns = current.evaluatedTurns + 1
    const consecutiveNoToolTurns = turn.usedTools ? 0 : current.consecutiveNoToolTurns + 1
    const evaluatorModel = context.evaluatorModel
    switch (result.verdict.verdict) {
      case "not_yet_met": {
        if (consecutiveNoToolTurns >= 8) {
          const goal = this.commit({
            ...current,
            status: "suspended",
            suspendedAt: Date.now(),
            suspensionCause: "no_progress",
            usage,
            evaluatedTurns,
            evaluatorModel,
            lastReason: result.verdict.reason,
            consecutiveNoToolTurns,
          })
          return { status: "suspended", goal }
        }
        const goal = this.commit({
          ...current,
          usage,
          evaluatedTurns,
          evaluatorModel,
          lastReason: result.verdict.reason,
          consecutiveNoToolTurns,
        })
        return { status: "continue", goal }
      }
      case "met": {
        const goal = this.commit({
          ...current,
          status: "achieved",
          endedAt: Date.now(),
          usage,
          evaluatedTurns,
          evaluatorModel,
          lastReason: result.verdict.reason,
          consecutiveNoToolTurns,
        })
        return { status: "achieved", goal }
      }
      case "impossible": {
        const goal = this.commit({
          ...current,
          status: "impossible",
          endedAt: Date.now(),
          usage,
          evaluatedTurns,
          evaluatorModel,
          lastReason: result.verdict.reason,
          consecutiveNoToolTurns,
        })
        return { status: "impossible", goal }
      }
    }
  }

  private commit<Snapshot extends GoalSnapshot>(snapshot: Snapshot): Snapshot {
    this.goal = snapshot
    this.host.emit({ type: "goal_updated", goal: snapshot })
    return snapshot
  }
}
