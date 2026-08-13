import { basename } from "node:path"
import { registerPrompt } from "../agent/prompt"
import { registerCommand } from "../commands/registry"
import { asString, isRecord } from "../lib/json"
import { compactPath } from "../lib/path"
import { registerTool } from "../tools/registry"
import { registerToolRenderer } from "../ui/extension"
import { submitPlanTool } from "./tool"
import type { SessionPlan } from "./types"

function planContext(plan: SessionPlan): string {
  const label = plan.status === "approved" ? "approved" : "draft"
  return [
    `Current ${label} plan (${plan.path}):`,
    "<session-plan>",
    plan.markdown,
    "</session-plan>",
    plan.feedback ? `Review feedback: ${plan.feedback}` : "",
  ]
    .filter(Boolean)
    .join("\n")
}

function summarize(output: string): string | undefined {
  let result: unknown
  try {
    result = JSON.parse(output)
  } catch {
    return undefined
  }
  if (!isRecord(result)) return undefined
  const status = asString(result.status)
  const path = asString(result.path)
  if (!path) return undefined
  if (status === "approved") return `approved · ${basename(path)}`
  if (status === "revision_requested") return `revision requested · ${basename(path)}`
  if (status === "review_dismissed") return `review dismissed · ${basename(path)}`
  return undefined
}

export function registerPlans(): void {
  registerCommand({
    name: "plan",
    describe: "enter planning mode and optionally submit a prompt · [prompt]",
    async run(args, command) {
      const prompt = args.join(" ").trim()
      const entered = command.session.currentMode !== "plan"
      if (entered) command.session.setMode("plan")
      if (prompt) {
        if (!command.session.send({ text: prompt, images: [] })) {
          throw new Error("plan mode is active, but the prompt could not be submitted")
        }
        return
      }
      const current = command.session.currentPlan
      command.print(
        current
          ? `plan mode is active · revising ${compactPath(current.path)}`
          : entered
            ? "plan mode active"
            : "plan mode is already active",
      )
    },
  })
  registerPrompt({
    id: "plan-workflow",
    text(prompt) {
      if (prompt.kind === "subagent") return ""
      if (prompt.mode === "plan") {
        const canSubmit = prompt.tools.some((tool) => tool.name === submitPlanTool.name)
        return [
          "Investigate until the requested change is fully grounded, resolve material ambiguity, and produce an implementation-ready plan without changing the workspace.",
          canSubmit
            ? "When the plan is ready, call submit_plan with the complete Markdown. The tool displays it for review and asks for approval. Do not implement it unless that call reports approval. If review is dismissed, stop and wait."
            : "When the plan is ready, return the complete implementation plan as the final response.",
          prompt.plan ? planContext(prompt.plan) : "",
        ]
          .filter(Boolean)
          .join("\n")
      }
      if (!prompt.plan || prompt.plan.status !== "approved") return ""
      return [
        "The user approved the session plan below. Implement it now, treating it as the current handoff while still honoring newer user instructions.",
        planContext(prompt.plan),
      ].join("\n")
    },
  })
  registerTool(submitPlanTool)
  registerToolRenderer({
    tool: submitPlanTool.name,
    summarize: (output) => summarize(output) ?? "invalid result",
    failed: (output) => summarize(output) === undefined,
  })
}
