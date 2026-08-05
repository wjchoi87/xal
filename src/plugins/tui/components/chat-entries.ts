import { TextAttributes, type BoxRenderable, type CliRenderer, type Renderable } from "@opentui/core"
import { formatTimestamp } from "../lib/format"
import { renderInlineMarkdown } from "../lib/markdown"
import { column, detailPanel, label, paragraph, row } from "../lib/renderables"
import { COLORS } from "../theme/colors"
import { background } from "../theme/styles"
import { StreamingText } from "./streaming-text"

export interface Collapsible {
  setExpanded(expanded: boolean): void
}

export interface StreamingEntry {
  view: Renderable
  stream: StreamingText
}

export interface CollapsibleEntry {
  view: Renderable
  collapsible: Collapsible
}

export function userEntry(renderer: CliRenderer, text: string, sentAt: number): BoxRenderable {
  const box = row(renderer, {
    alignItems: "flex-start",
    padding: 1,
    ...background(COLORS.userBackground),
  })
  box.add(
    paragraph(renderer, {
      content: text,
      flexGrow: 1,
      background: COLORS.userBackground,
    }),
  )
  box.add(
    label(renderer, {
      content: formatTimestamp(sentAt),
      flexShrink: 0,
      marginLeft: 2,
      attributes: TextAttributes.DIM,
      background: COLORS.userBackground,
    }),
  )
  return box
}

export function infoEntry(renderer: CliRenderer, text: string): Renderable {
  return paragraph(renderer, { content: text, attributes: TextAttributes.DIM })
}

export function errorEntry(renderer: CliRenderer, text: string): Renderable {
  return paragraph(renderer, { content: `x ${text}`, color: COLORS.error })
}

export function assistantEntry(renderer: CliRenderer): StreamingEntry {
  const view = paragraph(renderer, { content: "" })
  return {
    view,
    stream: new StreamingText((content) => {
      view.content = content
    }),
  }
}

export function reasoningEntry(renderer: CliRenderer): StreamingEntry {
  const view = paragraph(renderer, { content: "", color: COLORS.dim })
  const attributes = TextAttributes.DIM | TextAttributes.ITALIC
  return {
    view,
    stream: new StreamingText((content) => {
      view.content = renderInlineMarkdown(content, COLORS.dim, attributes)
    }),
  }
}

export function collapsibleEntry(
  renderer: CliRenderer,
  summary: string,
  details: string[],
  expanded: boolean,
): CollapsibleEntry {
  const view = column(renderer)
  view.add(paragraph(renderer, { content: summary, color: COLORS.warning }))

  const body = detailPanel(renderer, { visible: expanded })
  for (const detail of details) {
    body.add(paragraph(renderer, { content: detail, color: COLORS.error }))
  }
  view.add(body)

  return {
    view,
    collapsible: {
      setExpanded(next) {
        body.visible = next
      },
    },
  }
}
