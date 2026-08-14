import { RGBA, type TerminalColors } from "@opentui/core"
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

function replaceColor(target: RGBA, source: RGBA): void {
  target.buffer.set(source.buffer)
}

function indexedColor(palette: TerminalColors, index: number): RGBA {
  return RGBA.fromIndex(index, palette.palette[index] ?? undefined)
}

export function applyTerminalPalette(palette: TerminalColors): void {
  replaceColor(COLORS.foreground, RGBA.defaultForeground(palette.defaultForeground ?? undefined))
  replaceColor(COLORS.background, RGBA.defaultBackground(palette.defaultBackground ?? undefined))
  replaceColor(COLORS.faint, indexedColor(palette, 8))
  replaceColor(COLORS.accent, indexedColor(palette, 12))
  replaceColor(COLORS.agent, indexedColor(palette, 13))
  replaceColor(COLORS.success, indexedColor(palette, 10))
  replaceColor(COLORS.error, indexedColor(palette, 9))
  replaceColor(COLORS.warning, indexedColor(palette, 11))
  replaceColor(COLORS.border, indexedColor(palette, 8))
  replaceColor(COLORS.selection, indexedColor(palette, 4))
  replaceColor(COLORS.code, indexedColor(palette, 14))
  replaceColor(COLORS.keyword, indexedColor(palette, 13))
  replaceColor(COLORS.literal, indexedColor(palette, 10))
  replaceColor(COLORS.number, indexedColor(palette, 11))
}

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
