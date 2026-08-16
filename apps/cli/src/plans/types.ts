import { isAbsolute } from "node:path"
import { asString, isRecord } from "../lib/json"

export const MAX_PLAN_LENGTH = 50_000

export type PlanStatus = "draft" | "approved"

export interface SessionPlan {
  path: string
  markdown: string
  status: PlanStatus
  feedback?: string
}

export interface PlanUpdatedEvent {
  type: "plan_updated"
  plan: SessionPlan
}

export function parsePlanMarkdown(value: unknown): string | undefined {
  const markdown = asString(value)?.trim()
  if (!markdown || markdown.length > MAX_PLAN_LENGTH) return undefined
  return markdown
}

export function parseSessionPlan(value: unknown): SessionPlan | undefined {
  if (!isRecord(value)) return undefined
  const path = asString(value.path)
  const markdown = parsePlanMarkdown(value.markdown)
  const status = asString(value.status)
  const feedback = asString(value.feedback)
  if (!path || !isAbsolute(path) || !markdown) return undefined
  if (status !== "draft" && status !== "approved") return undefined
  if (feedback !== undefined && !feedback.trim()) return undefined
  return { path, markdown, status, ...(feedback ? { feedback } : {}) }
}
