const SEPARATORS = new Set([" ", "\t", "-", "_", ".", "/", "\\", ":", "@", ",", "(", ")", "[", "]", "|"])

const CONTIGUOUS_BONUS = 8
const BOUNDARY_BONUS = 6
const PREFIX_BONUS = 12
const EXACT_BONUS = 20
const GAP_PENALTY = 1
const DISTANCE_PENALTY = 0.2
const LENGTH_PENALTY = 0.05

export interface FuzzyField {
  text: string
  weight: number
}

interface Compact {
  chars: string
  boundary: boolean[]
}

function isDigit(character: string): boolean {
  return character >= "0" && character <= "9"
}

function compact(text: string): Compact {
  const chars: string[] = []
  const boundary: boolean[] = []
  let previous: string | undefined
  let afterSeparator = true

  for (const character of text) {
    if (SEPARATORS.has(character)) {
      afterSeparator = true
      continue
    }
    const lower = character.toLowerCase()
    const camel = character !== lower && previous !== undefined && previous === previous.toLowerCase()
    const digitShift = previous !== undefined && isDigit(character) !== isDigit(previous)
    chars.push(lower)
    boundary.push(afterSeparator || camel || digitShift)
    previous = character
    afterSeparator = false
  }

  return { chars: chars.join(""), boundary }
}

function subsequence(term: string, text: string): boolean {
  let offset = 0
  for (const character of term) {
    const found = text.indexOf(character, offset)
    if (found < 0) return false
    offset = found + 1
  }
  return true
}

function scoreTerm(term: string, candidate: Compact): number | undefined {
  const { chars, boundary } = candidate
  let end = 0
  for (const character of term) {
    const found = chars.indexOf(character, end)
    if (found < 0) return undefined
    end = found + 1
  }

  let start = end
  for (let position = term.length - 1; position >= 0; position--) {
    start = chars.lastIndexOf(term[position]!, start - 1)
  }

  const gaps = end - start - term.length
  if (gaps > term.length * 2 + 4) return undefined

  let score = term.length - gaps * GAP_PENALTY - start * DISTANCE_PENALTY - chars.length * LENGTH_PENALTY
  let cursor = start
  let previous = -1
  for (const character of term) {
    const at = chars.indexOf(character, cursor)
    if (at === previous + 1 && previous >= 0) score += CONTIGUOUS_BONUS
    else if (boundary[at]) score += BOUNDARY_BONUS
    cursor = at + 1
    previous = at
  }

  if (start === 0) score += PREFIX_BONUS
  if (term.length === chars.length) score += EXACT_BONUS
  return score
}

export function fuzzyTerms(query: string): string[] {
  return query
    .split(/\s+/)
    .map((term) => compact(term).chars)
    .filter(Boolean)
}

export function fuzzyScore(query: string, fields: FuzzyField[]): number | undefined {
  const terms = fuzzyTerms(query)
  if (terms.length === 0) return 0

  const candidates = fields.map((field) => ({
    text: field.text,
    lower: field.text.toLowerCase(),
    weight: field.weight,
    compact: undefined as Compact | undefined,
  }))
  let total = 0
  for (const term of terms) {
    let best: number | undefined
    for (const candidate of candidates) {
      if (!subsequence(term, candidate.lower)) continue
      candidate.compact ??= compact(candidate.text)
      const score = scoreTerm(term, candidate.compact)
      if (score === undefined) continue
      const weighted = score * candidate.weight
      if (best === undefined || weighted > best) best = weighted
    }
    if (best === undefined) return undefined
    total += best
  }
  return total
}
