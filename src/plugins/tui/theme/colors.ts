import { RGBA } from "@opentui/core"
import type { ThemeColors } from "../../../ui/extension"
import { terminalPresentation } from "../terminal"

export const COLORS: ThemeColors = {
  foreground: RGBA.defaultForeground(),
  background: RGBA.defaultBackground(),
  faint: RGBA.fromIndex(8),
  accent: RGBA.fromIndex(12),
  agent: RGBA.fromIndex(13),
  success: RGBA.fromIndex(10),
  error: RGBA.fromIndex(9),
  warning: RGBA.fromIndex(11),
  border: RGBA.fromIndex(8),
  selection: RGBA.fromIndex(4),
  code: RGBA.fromIndex(14),
  keyword: RGBA.fromIndex(13),
  literal: RGBA.fromIndex(10),
  number: RGBA.fromIndex(11),
}

export const colorsEnabled = terminalPresentation.colors

export function userMessageBackground(background: RGBA): RGBA {
  if (!colorsEnabled) return COLORS.background
  const target = background.r * 0.299 + background.g * 0.587 + background.b * 0.114 > 0.5 ? 0 : 1
  return RGBA.fromValues(
    background.r + (target - background.r) * 0.08,
    background.g + (target - background.g) * 0.08,
    background.b + (target - background.b) * 0.08,
  )
}

export function resolveColor(value: RGBA): RGBA {
  return colorsEnabled ? value : COLORS.foreground
}
