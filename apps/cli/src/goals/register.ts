import { registerCommand } from "../commands/registry"
import type { Usage } from "../providers/types"
import type { GoalSnapshot } from "./types"
import { parseGoalArguments } from "./invocation"

function elapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

function tokens(usage: Usage): number {
  return (usage.totalInputTokens ?? 0) + (usage.outputTokens ?? 0)
}

export function formatGoalStatus(goal: GoalSnapshot): string {
  const endedAt = goal.status === "active" ? Date.now() : goal.status === "suspended" ? goal.suspendedAt : goal.endedAt
  const lines = [
    `Goal ${goal.status}: ${goal.condition}`,
    `Elapsed: ${elapsed(endedAt - goal.startedAt)}`,
    `Evaluated turns: ${goal.evaluatedTurns}`,
    `Tokens: ${tokens(goal.usage).toLocaleString("en-US")}`,
    `Evaluator: ${goal.evaluatorModel}`,
  ]
  if (goal.lastReason) lines.push(`Latest reason: ${goal.lastReason}`)
  return lines.join("\n")
}

export function registerGoals(): void {
  registerCommand({
    name: "goal",
    describe: "run until a measurable condition is met · [condition|clear]",
    async run(args, command) {
      const invocation = parseGoalArguments(args)
      if (invocation.type === "status") {
        const goal = command.session.currentGoal
        command.print(goal ? formatGoalStatus(goal) : "No goal set")
        return
      }
      if (invocation.type === "clear") {
        const cleared = command.session.clearGoal()
        command.print(cleared?.status === "cleared" ? `Goal cleared: ${cleared.condition}` : "No goal set")
        return
      }
      command.busy("Starting goal")
      if (!(await command.session.setGoal(invocation.condition))) {
        throw new Error("cannot set a goal while history, an interaction, or goal evaluation is active")
      }
    },
  })
}
