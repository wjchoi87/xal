import { resumeSession } from "../agent/compose"
import { registerCommand } from "../commands/registry"
import type { Command } from "../commands/types"
import { compactPath } from "../lib/path"
import { formatRelative } from "../lib/time"
import { listSessions } from "./store"

const clearCommand: Command = {
  name: "clear",
  describe: "start a new session",
  async run(_args, ctx) {
    if (!ctx.session.reset()) ctx.print("cannot start a new session while a turn is running")
  },
}

const renameCommand: Command = {
  name: "rename",
  describe: "rename the current session",
  async run(args, ctx) {
    const title = ctx.session.setTitle(args.join(" "))
    if (!title) throw new Error("usage: /rename <title>")
    ctx.print(`session renamed to ${title}`)
  },
}

const resumeCommand: Command = {
  name: "resume",
  describe: "reopen a saved session · /resume all searches every project",
  async run(args, ctx) {
    const everywhere = args[0] === "all"
    ctx.busy("Loading sessions")
    const sessions = await listSessions(everywhere ? undefined : process.cwd())
    ctx.busy()
    if (sessions.length === 0) {
      ctx.print("no saved sessions yet")
      return
    }

    const summary = await ctx.select({
      search: "filter sessions",
      options: sessions.map((summary) => ({
        label: summary.title,
        detail: formatRelative(summary.updatedAt),
        note: everywhere ? compactPath(summary.cwd) : `${summary.messages} msgs`,
        value: summary,
      })),
    })
    if (!summary) return

    for (const notice of await resumeSession(ctx.session, summary)) ctx.print(notice)
  },
}

export function registerSessionCommands(): void {
  registerCommand(clearCommand)
  registerCommand(renameCommand)
  registerCommand(resumeCommand)
}
