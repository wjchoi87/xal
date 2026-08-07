import { resumeSession } from "../agent/compose"
import { compactPath } from "../lib/path"
import { formatRelative } from "../lib/time"
import { listSessions } from "../sessions/store"
import type { Command } from "./types"

export const resumeCommand: Command = {
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
