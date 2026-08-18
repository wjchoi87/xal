export function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens)
  const thousands = tokens / 1000
  return thousands < 99.95 ? `${thousands.toFixed(1)}K` : `${Math.round(thousands)}K`
}
