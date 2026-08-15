import { appInfo } from "../../app-info"

const EXCERPT_CHARS = 200

function transport(sequence: string, tmux: boolean): string {
  if (!tmux) return sequence
  return `\u001bPtmux;${sequence.replaceAll("\u001b", "\u001b\u001b")}\u001b\\`
}

export function notificationSequence(message: string, tmux: boolean): string {
  const safe = message.replace(/\p{Cc}/gu, "").replaceAll(";", ",")
  return transport(`\u001b]777;notify;${appInfo.displayName};${safe}\u001b\\`, tmux)
}

export function progressSequence(active: boolean, tmux: boolean): string {
  return transport(active ? "\u001b]9;4;3\u001b\\" : "\u001b]9;4;0\u001b\\", tmux)
}

export function notificationExcerpt(text: string): string {
  const normalized = text
    .replace(/\p{Cc}/gu, " ")
    .trim()
    .split(/\s+/u)
    .filter(Boolean)
    .join(" ")
  const characters = [...normalized]
  if (characters.length <= EXCERPT_CHARS) return normalized
  return `…${characters.slice(-(EXCERPT_CHARS - 1)).join("")}`
}

export function isNotificationSeparator(character: string): boolean {
  return /[\s\p{Cc}]/u.test(character)
}
