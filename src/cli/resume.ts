import { settings } from "../config/settings"
import { findSession, latestSession } from "../sessions/store"
import { getUi } from "../ui/registry"
import type { Cli } from "./types"

export const resumeCli: Cli = {
  name: "resume",
  describe: "reopen a saved session",
  usage: "resume [session-id]",
  async run(args) {
    const id = args[0]
    const summary = id ? await findSession(id) : await latestSession(process.cwd())
    if (!summary) throw new Error(id ? `unknown session: ${id}` : "no saved sessions for this directory")

    const uiId = settings().ui ?? "tui"
    const ui = getUi(uiId)
    if (!ui) throw new Error(`unknown ui: ${uiId}`)
    await ui.start({ resume: summary })
  },
}
