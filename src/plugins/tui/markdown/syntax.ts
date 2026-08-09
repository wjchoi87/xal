export type CodeTokenKind = "plain" | "keyword" | "string" | "number" | "comment"

export interface CodeToken {
  text: string
  kind: CodeTokenKind
}

interface Grammar {
  keywords: ReadonlySet<string>
  lineComments: readonly string[]
  blockComment: readonly [string, string] | undefined
  quotes: readonly string[]
}

const IDENTIFIER_START = /[A-Za-z_$]/
const IDENTIFIER = /[A-Za-z0-9_$]/
const NUMBER = /[0-9]/
const NUMBER_BODY = /[0-9a-fA-FxXoObB._]/

function grammar(
  keywords: string,
  lineComments: readonly string[],
  blockComment: readonly [string, string] | undefined,
  quotes: readonly string[] = ['"', "'"],
): Grammar {
  return { keywords: new Set(keywords.split(" ").filter(Boolean)), lineComments, blockComment, quotes }
}

const SCRIPT = grammar(
  "as async await break case catch class const continue debugger declare default delete do else enum export extends false finally for from function get if implements import in infer instanceof interface keyof let new null of private protected public readonly return satisfies set static super switch this throw true try type typeof undefined var void while with yield",
  ["//"],
  ["/*", "*/"],
  ['"', "'", "`"],
)

const PYTHON = grammar(
  "and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return self True try while with yield",
  ["#"],
  undefined,
)

const GO = grammar(
  "break case chan const continue default defer else fallthrough false for func go goto if import interface map nil package range return select struct switch true type var",
  ["//"],
  ["/*", "*/"],
  ['"', "'", "`"],
)

const RUST = grammar(
  "as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self static struct super trait true type unsafe use where while",
  ["//"],
  ["/*", "*/"],
)

const SHELL = grammar(
  "case do done elif else esac export fi for function if in local readonly return set source then unset until while",
  ["#"],
  undefined,
)

const SQL = grammar(
  "all alter and as asc by create delete desc distinct drop exists from group having in index inner insert into is join key left like limit not null offset on or order outer primary references right select set table union update values where",
  ["--"],
  ["/*", "*/"],
)

const CURLY = grammar(
  "auto bool break case catch char class const constexpr continue default delete do double else enum explicit extern false final float for friend goto if implements import inline int interface long namespace new nullptr operator package private protected public return short signed sizeof static struct switch template this throw true try typedef typename union unsigned using virtual void volatile while",
  ["//"],
  ["/*", "*/"],
)

const DATA = grammar("false null true", ["#"], undefined)

const STYLES = grammar("", [], ["/*", "*/"])

const GRAMMARS = new Map<string, Grammar>([
  ["typescript", SCRIPT],
  ["ts", SCRIPT],
  ["tsx", SCRIPT],
  ["javascript", SCRIPT],
  ["js", SCRIPT],
  ["jsx", SCRIPT],
  ["mjs", SCRIPT],
  ["cjs", SCRIPT],
  ["python", PYTHON],
  ["py", PYTHON],
  ["go", GO],
  ["rust", RUST],
  ["rs", RUST],
  ["bash", SHELL],
  ["sh", SHELL],
  ["shell", SHELL],
  ["zsh", SHELL],
  ["console", SHELL],
  ["sql", SQL],
  ["c", CURLY],
  ["cpp", CURLY],
  ["c++", CURLY],
  ["java", CURLY],
  ["cs", CURLY],
  ["csharp", CURLY],
  ["swift", CURLY],
  ["kotlin", CURLY],
  ["json", DATA],
  ["jsonc", DATA],
  ["yaml", DATA],
  ["yml", DATA],
  ["toml", DATA],
  ["css", STYLES],
  ["scss", STYLES],
])

const PLAIN: Grammar = { keywords: new Set(), lineComments: [], blockComment: undefined, quotes: ['"', "'"] }

export function highlightCode(lines: readonly string[], language: string): CodeToken[][] {
  const rules = GRAMMARS.get(language) ?? PLAIN
  let commented = false

  return lines.map((line) => {
    const tokens: CodeToken[] = []
    let plain = ""
    let index = 0

    const push = (text: string, kind: CodeTokenKind): void => {
      if (plain) {
        tokens.push({ text: plain, kind: "plain" })
        plain = ""
      }
      if (text) tokens.push({ text, kind })
    }

    while (index < line.length) {
      if (commented && rules.blockComment) {
        const close = line.indexOf(rules.blockComment[1], index)
        const end = close === -1 ? line.length : close + rules.blockComment[1].length
        push(line.slice(index, end), "comment")
        commented = close === -1
        index = end
        continue
      }

      const rest = line.slice(index)
      const lineComment = rules.lineComments.find((token) => rest.startsWith(token))
      if (lineComment) {
        push(rest, "comment")
        index = line.length
        continue
      }

      if (rules.blockComment && rest.startsWith(rules.blockComment[0])) {
        commented = true
        continue
      }

      const quote = rules.quotes.find((mark) => rest.startsWith(mark))
      if (quote) {
        const end = closingQuote(line, index + quote.length, quote)
        push(line.slice(index, end), "string")
        index = end
        continue
      }

      const char = line[index]!
      if (IDENTIFIER_START.test(char)) {
        let cursor = index
        while (cursor < line.length && IDENTIFIER.test(line[cursor]!)) cursor += 1
        const word = line.slice(index, cursor)
        if (rules.keywords.has(word)) push(word, "keyword")
        else plain += word
        index = cursor
        continue
      }

      if (NUMBER.test(char)) {
        let cursor = index
        while (cursor < line.length && NUMBER_BODY.test(line[cursor]!)) cursor += 1
        push(line.slice(index, cursor), "number")
        index = cursor
        continue
      }

      plain += char
      index += 1
    }

    push("", "plain")
    return tokens
  })
}

function closingQuote(line: string, start: number, quote: string): number {
  let index = start
  while (index < line.length) {
    if (line[index] === "\\") {
      index += 2
      continue
    }
    if (line.startsWith(quote, index)) return index + quote.length
    index += 1
  }
  return line.length
}
