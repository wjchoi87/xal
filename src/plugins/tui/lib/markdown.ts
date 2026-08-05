import { StyledText, TextAttributes, type RGBA, type TextChunk } from "@opentui/core"
import { resolveColor } from "../theme/colors"

export function renderInlineMarkdown(content: string, color: RGBA, attributes = TextAttributes.NONE): StyledText {
  const chunks: TextChunk[] = []
  const foreground = resolveColor(color)
  let cursor = 0
  let strong = false

  while (cursor < content.length) {
    const marker = content.indexOf("**", cursor)
    const end = marker === -1 ? content.length : marker
    if (end > cursor) {
      chunks.push({
        __isChunk: true,
        text: content.slice(cursor, end),
        fg: foreground,
        attributes: attributes | (strong ? TextAttributes.BOLD : TextAttributes.NONE),
      })
    }
    if (marker === -1) break
    strong = !strong
    cursor = marker + 2
  }

  return new StyledText(chunks)
}
