export interface SplitCommand {
  segments: string[]
  redirected: boolean
}

function readSingleQuoted(command: string, start: number): { text: string; end: number } {
  const close = command.indexOf("'", start + 1)
  if (close < 0) return { text: command.slice(start), end: command.length }
  return { text: command.slice(start, close + 1), end: close + 1 }
}

function readDoubleQuoted(command: string, start: number): { text: string; end: number } | undefined {
  let index = start + 1
  while (index < command.length) {
    const char = command[index]!
    if (char === "\\") {
      index += 2
      continue
    }
    if (char === "`") return undefined
    if (char === "$" && command[index + 1] === "(") return undefined
    if (char === '"') return { text: command.slice(start, index + 1), end: index + 1 }
    index += 1
  }
  return undefined
}

export function splitCommand(command: string): SplitCommand | undefined {
  const segments: string[] = []
  let current = ""
  let redirected = false
  let index = 0
  const push = (): void => {
    const segment = current.trim()
    if (segment) segments.push(segment)
    current = ""
  }
  while (index < command.length) {
    const char = command[index]!
    if (char === "\\") {
      current += command.slice(index, index + 2)
      index += 2
      continue
    }
    if (char === "'") {
      const quoted = readSingleQuoted(command, index)
      current += quoted.text
      index = quoted.end
      continue
    }
    if (char === '"') {
      const quoted = readDoubleQuoted(command, index)
      if (!quoted) return undefined
      current += quoted.text
      index = quoted.end
      continue
    }
    if (char === "`" || (char === "$" && command[index + 1] === "(")) return undefined
    if (char === "(" || char === ")" || char === "{" || char === "}") return undefined
    if (char === "&" && command[index + 1] === "&") {
      push()
      index += 2
      continue
    }
    if (char === "&" && command[index + 1] === ">") {
      redirected = true
      current += "&>"
      index += 2
      continue
    }
    if (char === "&" && command[index - 1] === ">") {
      current += char
      index += 1
      continue
    }
    if (char === "&") return undefined
    if (char === "|" || char === ";" || char === "\n") {
      push()
      index += char === "|" && command[index + 1] === "|" ? 2 : 1
      continue
    }
    if (char === "<" || char === ">") {
      redirected = true
      current += char
      index += 1
      continue
    }
    current += char
    index += 1
  }
  push()
  if (segments.length === 0) return undefined
  return { segments, redirected }
}
