import type { RGBA, StyledText } from "@opentui/core"

export interface ToolRenderer {
  tool: string
  waitingLabel?(title: string): string
  summarize?(output: string): string
  failed?(output: string): boolean
  renderOutput?(output: string, width: number): { content: StyledText; rows: number }
}

export interface ThemeColors {
  foreground: RGBA
  background: RGBA
  userBackground: RGBA
  dim: RGBA
  faint: RGBA
  accent: RGBA
  agent: RGBA
  success: RGBA
  error: RGBA
  warning: RGBA
  border: RGBA
  selection: RGBA
}

const renderers = new Map<string, ToolRenderer>()
let overrides: Partial<ThemeColors> = {}

export function registerToolRenderer(renderer: ToolRenderer): void {
  renderers.set(renderer.tool, renderer)
}

export function getToolRenderer(tool: string): ToolRenderer | undefined {
  return renderers.get(tool)
}

export function setTheme(values: Partial<ThemeColors>): void {
  overrides = { ...overrides, ...values }
}

export function themeOverrides(): Partial<ThemeColors> {
  return overrides
}
