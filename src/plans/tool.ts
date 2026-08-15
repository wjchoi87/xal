import { join } from "node:path"
import { appInfo } from "../app-info"
import { writeSecureText } from "../lib/fs"
import { MAX_PLAN_LENGTH, parsePlanMarkdown, type SessionPlan } from "./types"
import type { InteractiveTool } from "../tools/types"

const APPROVE = "Approve and build"
const REVISE = "Request changes"

function markdownFrom(args: Record<string, unknown>): string {
  const markdown = parsePlanMarkdown(args.plan)
  if (markdown) return markdown
  throw new Error(`plan must be non-empty Markdown of at most ${MAX_PLAN_LENGTH} characters`)
}

function draft(path: string, markdown: string, feedback?: string): SessionPlan {
  return { path, markdown, status: "draft", ...(feedback ? { feedback } : {}) }
}

export const submitPlanTool: InteractiveTool = {
  name: "submit_plan",
  description:
    "Save the implementation plan for this session and ask the user to approve it or request revisions. Available only in interactive plan mode.",
  parameters: {
    type: "object",
    properties: {
      plan: {
        type: "string",
        minLength: 1,
        maxLength: MAX_PLAN_LENGTH,
        description: "The complete implementation-ready plan in Markdown",
      },
    },
    required: ["plan"],
    additionalProperties: false,
  },
  prompt:
    "Call submit_plan once the plan is complete and open questions are resolved, not before. Make the plan implementation-ready: concrete steps, the files to change, and the risks. The tool displays the Markdown for review and asks the user to approve or request changes; when changes are requested, revise and submit again.",
  interactive: true,
  available(ctx) {
    return ctx.interactive && ctx.mode === "plan"
  },
  title() {
    return "Submit implementation plan"
  },
  readOnly() {
    return true
  },
  async execute(args, ctx) {
    if (ctx.session.mode !== "plan") throw new Error("submit_plan is available only in plan mode")
    const markdown = markdownFrom(args)
    const path = join(ctx.session.directory, "plan.md")
    await writeSecureText(path, `${markdown}\n`)
    ctx.publish({ type: "plan_updated", plan: draft(path, markdown) })

    const result = await ctx.requestInput({
      questions: [
        {
          id: "plan_review",
          header: "Plan review",
          question: `Review the implementation plan above. What should ${appInfo.displayName} do?`,
          options: [
            {
              label: APPROVE,
              description: "Switch to normal mode and begin implementing this plan.",
            },
            {
              label: REVISE,
              description: "Keep plan mode active so the proposal can be revised.",
            },
          ],
        },
      ],
    })

    let status: "approved" | "revision_requested" | "review_dismissed"
    let plan: SessionPlan
    if (result.status === "rejected") {
      status = "review_dismissed"
      plan = draft(path, markdown, "Plan review was dismissed. Stop and wait for user direction.")
    } else {
      const answer = result.answers[0]?.value
      if (answer === APPROVE) {
        status = "approved"
        plan = { path, markdown, status: "approved" }
      } else {
        status = "revision_requested"
        plan = draft(path, markdown, answer === REVISE ? "Revise the plan before implementation." : (answer ?? REVISE))
      }
    }

    return {
      output: JSON.stringify({ status, path, ...(plan.feedback ? { feedback: plan.feedback } : {}) }),
      events: [{ type: "plan_updated", plan }],
    }
  },
}
