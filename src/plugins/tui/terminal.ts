import type { TerminalCapabilities } from "@opentui/core"
import { appInfo } from "../../app-info"
import { compactPath } from "../../lib/path"

const dumb = process.env.TERM?.toLowerCase() === "dumb"

export const terminalPresentation = {
  colors: !dumb && process.env.NO_COLOR === undefined,
  unicode: !dumb,
}

export function sessionTerminalTitle(title?: string, cwd = process.cwd()): string {
  return `${appInfo.name} — ${title ?? compactPath(cwd)}`
}

function terminalIdentity(capabilities: TerminalCapabilities): string {
  const name = capabilities.terminal.name || process.env.TERM || "unknown"
  const version = capabilities.terminal.version ? ` ${capabilities.terminal.version}` : ""
  const multiplexer = capabilities.multiplexer === "none" ? "" : ` via ${capabilities.multiplexer}`
  return `${name}${version}${multiplexer}`
}

function colorSupport(capabilities: TerminalCapabilities): string {
  if (!terminalPresentation.colors) return "disabled"
  if (capabilities.rgb) return "truecolor"
  if (capabilities.ansi256) return "256 colors"
  return "16 colors"
}

function supportedProtocols(capabilities: TerminalCapabilities): string[] {
  const protocols: string[] = []
  if (capabilities.kitty_keyboard) protocols.push("Kitty keyboard")
  if (capabilities.bracketed_paste) protocols.push("bracketed paste")
  if (capabilities.focus_tracking) protocols.push("focus tracking")
  if (capabilities.hyperlinks) protocols.push("hyperlinks")
  if (capabilities.osc52) protocols.push("OSC 52 clipboard")
  if (capabilities.notifications) protocols.push("notifications")
  if (capabilities.kitty_graphics) protocols.push("Kitty graphics")
  if (capabilities.sixel) protocols.push("Sixel graphics")
  return protocols
}

export function describeTerminal(capabilities: TerminalCapabilities | null): string[] {
  if (!capabilities) return ["terminal capabilities unavailable"]
  const glyphs = terminalPresentation.unicode ? `Unicode (${capabilities.unicode} widths)` : "ASCII"
  const protocols = supportedProtocols(capabilities)
  return [
    `terminal: ${terminalIdentity(capabilities)}`,
    `rendering: ${colorSupport(capabilities)} · ${glyphs}`,
    `protocols: ${protocols.length > 0 ? protocols.join(", ") : "none detected"}`,
  ]
}
