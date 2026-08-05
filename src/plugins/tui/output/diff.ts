import { classifyLine, isNotice, type OutputLine } from "./lines"

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

export function parseDiff(lines: string[]): OutputLine[] | undefined {
  if (!lines.some((line) => line.startsWith("@@"))) return undefined

  const parsed: OutputLine[] = []
  let oldLine: number | undefined
  let newLine: number | undefined

  for (const line of lines) {
    if (isNotice(line)) {
      parsed.push(classifyLine(line))
      continue
    }
    const hunk = HUNK.exec(line)
    if (hunk) {
      oldLine = Number(hunk[1])
      newLine = Number(hunk[2])
      parsed.push({ number: "", text: line, kind: "hunk" })
      continue
    }
    if (oldLine === undefined || newLine === undefined) {
      parsed.push({ number: "", text: line, kind: "faint" })
      continue
    }
    if (line.startsWith("-")) {
      parsed.push({ number: String(oldLine), text: line, kind: "removed" })
      oldLine += 1
      continue
    }
    if (line.startsWith("+")) {
      parsed.push({ number: String(newLine), text: line, kind: "added" })
      newLine += 1
      continue
    }
    if (line.startsWith(" ")) {
      parsed.push({ number: String(newLine), text: line, kind: "plain" })
      oldLine += 1
      newLine += 1
      continue
    }
    if (line.startsWith("\\")) {
      parsed.push({ number: "", text: line, kind: "plain" })
      continue
    }
    oldLine = undefined
    newLine = undefined
    parsed.push({ number: "", text: line, kind: "faint" })
  }

  return parsed
}
