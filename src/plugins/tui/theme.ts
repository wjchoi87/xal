import { dim, fg, RGBA, type StylableInput, type TextChunk } from "@opentui/core"
import { themeOverrides, type ThemeColors } from "../../ui/extension"

export const COLORS: ThemeColors = {
  foreground: RGBA.defaultForeground(),
  background: RGBA.defaultBackground(),
  userBackground: RGBA.fromIndex(8),
  dim: RGBA.fromIndex(8),
  faint: RGBA.fromIndex(8),
  accent: RGBA.fromIndex(12),
  agent: RGBA.fromIndex(13),
  success: RGBA.fromIndex(10),
  error: RGBA.fromIndex(9),
  warning: RGBA.fromIndex(11),
  border: RGBA.fromIndex(8),
  selection: RGBA.fromIndex(4),
  ...themeOverrides(),
}

export const colorsEnabled = process.env.NO_COLOR === undefined

function color(color: RGBA): RGBA {
  return colorsEnabled ? color : COLORS.foreground
}

export function background(colorValue = COLORS.background): { backgroundColor: RGBA } {
  return { backgroundColor: colorsEnabled ? colorValue : COLORS.background }
}

export function border(colorValue: RGBA): { borderColor: RGBA; focusedBorderColor: RGBA } {
  const resolved = color(colorValue)
  return { borderColor: resolved, focusedBorderColor: resolved }
}

export function textColors(colorValue = COLORS.foreground, backgroundValue = COLORS.background): {
  fg: RGBA
  bg: RGBA
  selectionBg: RGBA
  selectionFg: RGBA
} {
  return {
    fg: color(colorValue),
    bg: colorsEnabled ? backgroundValue : COLORS.background,
    selectionBg: colorsEnabled ? COLORS.selection : COLORS.foreground,
    selectionFg: COLORS.background,
  }
}

export function inputColors(): {
  backgroundColor: RGBA
  focusedBackgroundColor: RGBA
  textColor: RGBA
  focusedTextColor: RGBA
  placeholderColor: RGBA
  selectionBg: RGBA
  selectionFg: RGBA
  cursorColor: RGBA
} {
  return {
    backgroundColor: COLORS.background,
    focusedBackgroundColor: COLORS.background,
    textColor: COLORS.foreground,
    focusedTextColor: COLORS.foreground,
    placeholderColor: color(COLORS.faint),
    selectionBg: colorsEnabled ? COLORS.selection : COLORS.foreground,
    selectionFg: COLORS.background,
    cursorColor: COLORS.foreground,
  }
}

export function paint(colorValue: RGBA, input: StylableInput): TextChunk {
  return fg(color(colorValue))(input)
}

export function muted(input: StylableInput): TextChunk {
  return dim(fg(COLORS.foreground)(input))
}
