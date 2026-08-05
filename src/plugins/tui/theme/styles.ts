import { dim, fg, type RGBA, type StylableInput, type TextChunk } from "@opentui/core"
import { colorsEnabled, COLORS, resolveColor } from "./colors"

export function background(colorValue = COLORS.background): { backgroundColor: RGBA } {
  return { backgroundColor: colorsEnabled ? colorValue : COLORS.background }
}

export function border(colorValue: RGBA): { borderColor: RGBA; focusedBorderColor: RGBA } {
  const resolved = resolveColor(colorValue)
  return { borderColor: resolved, focusedBorderColor: resolved }
}

export function textColors(
  colorValue = COLORS.foreground,
  backgroundValue = COLORS.background,
): {
  fg: RGBA
  bg: RGBA
  selectionBg: RGBA
  selectionFg: RGBA
} {
  return {
    fg: resolveColor(colorValue),
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
    placeholderColor: resolveColor(COLORS.faint),
    selectionBg: colorsEnabled ? COLORS.selection : COLORS.foreground,
    selectionFg: COLORS.background,
    cursorColor: COLORS.foreground,
  }
}

export function paint(colorValue: RGBA, input: StylableInput): TextChunk {
  return fg(resolveColor(colorValue))(input)
}

export function muted(input: StylableInput): TextChunk {
  return dim(fg(COLORS.foreground)(input))
}
