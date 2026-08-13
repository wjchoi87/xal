import { homedir, tmpdir } from "node:os"
import { basename, isAbsolute, join, relative, resolve } from "node:path"

const PATH_COMMANDS = new Set([
  "rm",
  "rmdir",
  "mv",
  "cp",
  "mkdir",
  "touch",
  "chmod",
  "chown",
  "ln",
  "truncate",
  "shred",
  "tee",
  "cd",
  "pushd",
])

const DESTRUCTIVE = new Set(["rm", "rmdir", "mv", "shred", "truncate"])

const WRAPPERS = new Set(["env", "nohup", "nice", "stdbuf", "time", "timeout"])

const FIND_MUTATORS = new Set(["-delete", "-exec", "-execdir", "-ok", "-okdir"])

const DEVICES = new Set(["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty"])

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

interface Word {
  text: string
  dynamic: boolean
}

function readDoubleQuoted(segment: string, start: number, word: { text: string; dynamic: boolean }): number {
  let index = start
  while (index < segment.length) {
    const char = segment[index]!
    if (char === "\\") {
      word.text += segment[index + 1] ?? ""
      index += 2
      continue
    }
    if (char === '"') return index + 1
    if (char === "$" || char === "`") word.dynamic = true
    word.text += char
    index += 1
  }
  return index
}

function splitWords(segment: string): Word[] {
  const words: Word[] = []
  let current = { text: "", dynamic: false }
  let started = false
  let index = 0
  const push = (): void => {
    if (started) words.push(current)
    current = { text: "", dynamic: false }
    started = false
  }
  while (index < segment.length) {
    const char = segment[index]!
    if (char === " " || char === "\t") {
      push()
      index += 1
      continue
    }
    started = true
    if (char === "\\") {
      current.text += segment[index + 1] ?? ""
      index += 2
      continue
    }
    if (char === "'") {
      const close = segment.indexOf("'", index + 1)
      const end = close < 0 ? segment.length : close
      current.text += segment.slice(index + 1, end)
      index = end + 1
      continue
    }
    if (char === '"') {
      index = readDoubleQuoted(segment, index + 1, current)
      continue
    }
    if (char === "$" || char === "`") current.dynamic = true
    current.text += char
    index += 1
  }
  push()
  return words
}

function extractRedirects(words: Word[]): { targets: Word[]; remaining: Word[] } {
  const targets: Word[] = []
  const remaining: Word[] = []
  let index = 0
  while (index < words.length) {
    const word = words[index]!
    const stripped = word.text.replace(/^\d+/, "")
    const write = stripped.startsWith(">") || stripped.startsWith("&>")
    if (!write && !stripped.startsWith("<")) {
      remaining.push(word)
      index += 1
      continue
    }
    const rest = stripped.replace(/^&?>{1,2}|^</, "")
    if (rest.startsWith("&")) {
      index += 1
      continue
    }
    if (rest) {
      if (write) targets.push({ text: rest, dynamic: word.dynamic })
      index += 1
      continue
    }
    const target = words[index + 1]
    if (target && write) targets.push(target)
    index += 2
  }
  return { targets, remaining }
}

function commandAndArgs(words: Word[]): { name: string; args: Word[] } | undefined {
  let index = 0
  while (index < words.length) {
    const text = words[index]!.text
    if (ASSIGNMENT.test(text) || text.startsWith("-") || /^\d+[smhd]?$/.test(text) || WRAPPERS.has(basename(text))) {
      index += 1
      continue
    }
    return { name: basename(text), args: words.slice(index + 1) }
  }
  return undefined
}

function inside(path: string, root: string): boolean {
  const rel = relative(root, path)
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

function escapes(word: Word, cwd: string, destructive: boolean): boolean {
  if (word.dynamic) return true
  const text = word.text
  if (!text || text === "{}" || text === ";" || text === "+") return false
  const expanded = text === "~" || text.startsWith("~/") ? join(homedir(), text.slice(1)) : text
  if (expanded.startsWith("~")) return true
  const absolute = resolve(cwd, expanded)
  if (DEVICES.has(absolute)) return false
  if (inside(absolute, cwd)) {
    if (!destructive) return false
    const rel = relative(cwd, absolute)
    return rel === "" || rel === ".git" || rel.startsWith(".git/")
  }
  return !inside(absolute, tmpdir()) && !inside(absolute, "/tmp")
}

export function commandEscapesWorkspace(segment: string, cwd: string): boolean {
  const { targets, remaining } = extractRedirects(splitWords(segment))
  if (targets.some((target) => escapes(target, cwd, false))) return true
  const resolved = commandAndArgs(remaining)
  if (!resolved) return false
  const { name, args } = resolved
  if (name === "xargs") return args.some((arg) => DESTRUCTIVE.has(basename(arg.text)))
  if (name === "find") {
    if (!args.some((arg) => FIND_MUTATORS.has(arg.text))) return false
    const roots: Word[] = []
    for (const arg of args) {
      if (arg.text.startsWith("-")) break
      roots.push(arg)
    }
    if (roots.length === 0) return true
    return roots.some((root) => escapes(root, cwd, true))
  }
  if (!PATH_COMMANDS.has(name)) return false
  const destructive = DESTRUCTIVE.has(name)
  return args.some((arg) => !arg.text.startsWith("-") && escapes(arg, cwd, destructive))
}
