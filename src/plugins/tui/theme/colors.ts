import { RGBA } from "@opentui/core"
import type { ThemeColors } from "../../../ui/extension"
import { terminalPresentation } from "../terminal"

export const COLORS: ThemeColors = {
  foreground: RGBA.defaultForeground(),
  background: RGBA.defaultBackground(),
  dim: RGBA.fromIndex(0),
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

export function resolveColor(value: RGBA): RGBA {
  return colorsEnabled ? value : COLORS.foreground
}
