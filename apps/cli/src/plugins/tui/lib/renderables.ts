import {
  BorderChars,
  BoxRenderable,
  TextRenderable,
  type BoxOptions,
  type RenderContext,
  type RGBA,
  type TextOptions,
} from "@opentui/core"
import { COLORS } from "../theme/colors"
import { border, textColors } from "../theme/styles"
import { terminalGlyph } from "./text"

type TintedTextOptions = TextOptions & { color?: RGBA; background?: RGBA }

export function column(ctx: RenderContext, options: BoxOptions = {}): BoxRenderable {
  return new BoxRenderable(ctx, { flexDirection: "column", minWidth: 0, ...options })
}

export function row(ctx: RenderContext, options: BoxOptions = {}): BoxRenderable {
  return new BoxRenderable(ctx, { flexDirection: "row", minWidth: 0, ...options })
}

export function label(ctx: RenderContext, options: TintedTextOptions = {}): TextRenderable {
  const { color, background, ...rest } = options
  return new TextRenderable(ctx, {
    height: 1,
    wrapMode: "none",
    truncate: true,
    ...textColors(color, background),
    ...rest,
  })
}

export function paragraph(ctx: RenderContext, options: TintedTextOptions = {}): TextRenderable {
  const { color, background, ...rest } = options
  return new TextRenderable(ctx, {
    wrapMode: "word",
    ...textColors(color, background),
    ...rest,
  })
}

export function detailPanel(ctx: RenderContext, options: BoxOptions = {}): BoxRenderable {
  return column(ctx, {
    border: ["left"],
    customBorderChars: { ...BorderChars.single, vertical: terminalGlyph("│", "|") },
    paddingLeft: 1,
    ...border(COLORS.border),
    ...options,
  })
}
