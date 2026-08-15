import { el } from "./dom.ts"

const PATTERN = /`([^`]+)`|\*([^*]+)\*|~([^~]+)~|\[([^\]]+)\]\(([^)]+)\)/g

export function inline(text: string): DocumentFragment {
  const fragment = document.createDocumentFragment()
  let cursor = 0
  for (const match of text.matchAll(PATTERN)) {
    const start = match.index
    if (start > cursor) fragment.append(text.slice(cursor, start))
    fragment.append(span(match))
    cursor = start + match[0].length
  }
  if (cursor < text.length) fragment.append(text.slice(cursor))
  return fragment
}

function span(match: RegExpExecArray): Node {
  const [, code, bold, accent, label, href] = match
  if (code !== undefined) return el("span", "code", code)
  if (bold !== undefined) return el("span", "b", bold)
  if (accent !== undefined) return el("span", "acc", accent)
  if (label !== undefined && href !== undefined) {
    const anchor = el("a", undefined, label)
    anchor.href = href
    if (href.startsWith("http")) {
      anchor.target = "_blank"
      anchor.rel = "noreferrer"
    }
    return anchor
  }
  return document.createTextNode(match[0])
}
