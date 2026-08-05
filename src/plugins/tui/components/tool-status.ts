import { StyledText } from "@opentui/core"
import { displayWidth, firstLine } from "../lib/text"
import { COLORS } from "../theme/colors"
import { muted, paint } from "../theme/styles"

export type ToolPhase = "requested" | "running" | "settled"
export type ToolOutcome = "success" | "failure" | "denied"

export interface ToolStatus {
  phase: ToolPhase
  outcome: ToolOutcome
  summary: string
  elapsed: string
  width: number
}

export interface StatusText {
  content: StyledText
  plain: string
}

export function commandLabel(tool: string, title: string): string {
  const task = firstLine(title)
  return task ? `${tool} ${task}` : tool
}

export function statusText(status: ToolStatus): StatusText {
  if (status.phase !== "settled") {
    const state = status.phase === "requested" ? "approval" : "running"
    const plain = status.width > 52 ? `${state} - ${status.elapsed}` : state
    return { content: new StyledText([paint(COLORS.warning, plain)]), plain }
  }

  const glyph = status.outcome === "success" ? "✓" : "x"
  const color = status.outcome === "success" ? COLORS.success : COLORS.error
  let detail = ""
  if (status.width >= 68) detail = ` ${status.summary} - ${status.elapsed}`
  else if (status.width >= 46) detail = ` ${status.summary}`

  return {
    content: new StyledText([paint(color, glyph), muted(detail)]),
    plain: `${glyph}${detail}`,
  }
}

export function activityText(spinner: string, waiting: string, width: number): StyledText {
  const hint = width >= displayWidth(waiting) + 24 ? " · esc to interrupt" : ""
  return new StyledText([paint(COLORS.agent, spinner), muted(` ${waiting}`), paint(COLORS.faint, hint)])
}
