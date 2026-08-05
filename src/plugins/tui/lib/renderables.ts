import {
  BorderChars,
  BoxRenderable,
  TextRenderable,
  type BoxOptions,
  type CliRenderer,
  type RGBA,
  type TextOptions,
} from "@opentui/core"
import { COLORS } from "../theme/colors"
import { border, textColors } from "../theme/styles"
import { terminalGlyph } from "./text"

type TintedTextOptions = TextOptions & { color?: RGBA; background?: RGBA }

export function column(renderer: CliRenderer, options: BoxOptions = {}): BoxRenderable {
  return new BoxRenderable(renderer, { flexDirection: "column", minWidth: 0, ...options })
}

export function row(renderer: CliRenderer, options: BoxOptions = {}): BoxRenderable {
  return new BoxRenderable(renderer, { flexDirection: "row", minWidth: 0, ...options })
}

export function label(renderer: CliRenderer, options: TintedTextOptions = {}): TextRenderable {
  const { color, background, ...rest } = options
  return new TextRenderable(renderer, {
    height: 1,
    wrapMode: "none",
    truncate: true,
    ...textColors(color, background),
    ...rest,
  })
}

export function paragraph(renderer: CliRenderer, options: TintedTextOptions = {}): TextRenderable {
  const { color, background, ...rest } = options
  return new TextRenderable(renderer, {
    wrapMode: "word",
    ...textColors(color, background),
    ...rest,
  })
}

export function detailPanel(renderer: CliRenderer, options: BoxOptions = {}): BoxRenderable {
  return column(renderer, {
    border: ["left"],
    customBorderChars: { ...BorderChars.single, vertical: terminalGlyph("│", "|") },
    paddingLeft: 1,
    ...border(COLORS.border),
    ...options,
  })
}
