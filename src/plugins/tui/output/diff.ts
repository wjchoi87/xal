import { classifyLine, isNotice, type OutputLine } from "./lines"

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/
const FILE_HEADER =
  /^(?:diff |index |--- |\+\+\+ |old mode |new mode |new file |deleted file |similarity |rename |Binary files )/

export function parseDiff(lines: string[]): OutputLine[] | undefined {
  if (!lines.some((line) => line.startsWith("@@"))) return undefined
  return classifyDiff(lines)
}

export function classifyDiff(lines: string[]): OutputLine[] {
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
    if (FILE_HEADER.test(line)) {
      oldLine = undefined
      newLine = undefined
      parsed.push({ number: "", text: line, kind: "faint" })
      continue
    }
    if (line.startsWith("-")) {
      parsed.push({ number: lineNumber(oldLine), text: line, kind: "removed" })
      if (oldLine !== undefined) oldLine += 1
      continue
    }
    if (line.startsWith("+")) {
      parsed.push({ number: lineNumber(newLine), text: line, kind: "added" })
      if (newLine !== undefined) newLine += 1
      continue
    }
    if (line.startsWith(" ") || line === "") {
      parsed.push({ number: lineNumber(newLine), text: line, kind: "plain" })
      if (oldLine !== undefined) oldLine += 1
      if (newLine !== undefined) newLine += 1
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

function lineNumber(value: number | undefined): string {
  return value === undefined ? "" : String(value)
}
