import { bold, stringToStyledText, StyledText, type TextChunk } from "@opentui/core"
import { findSkillReferences } from "../../../skills/references"
import { COLORS } from "../theme/colors"
import { paint } from "../theme/styles"

export function highlightSkillReferences(text: string): string | StyledText {
  const references = findSkillReferences(text)
  if (references.length === 0) return text

  const chunks: TextChunk[] = []
  let offset = 0
  for (const reference of references) {
    chunks.push(...stringToStyledText(text.slice(offset, reference.start)).chunks)
    chunks.push(bold(paint(COLORS.accent, text.slice(reference.start, reference.end))))
    offset = reference.end
  }
  chunks.push(...stringToStyledText(text.slice(offset)).chunks)
  return new StyledText(chunks)
}
