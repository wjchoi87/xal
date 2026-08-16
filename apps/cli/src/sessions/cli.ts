import { appInfo } from "../app-info"
import { readBgLease } from "../bg/state"
import { registerCli } from "../cli/registry"
import type { Cli } from "../cli/types"
import { settings } from "../config/settings"
import { getUi } from "../ui/registry"
import { findSession, latestSession } from "./store"

const resumeCli: Cli = {
  name: "resume",
  describe: "reopen a saved session",
  usage: "resume [session-id]",
  async run(args) {
    const id = args[0]
    const summary = id ? await findSession(id) : await latestSession(process.cwd())
    if (!summary) throw new Error(id ? `unknown session: ${id}` : "no saved sessions for this directory")
    if (await readBgLease(summary.id)) {
      const short = summary.id.slice(0, 8)
      throw new Error(`session ${short} is running in the background; use "${appInfo.name} bg attach ${short}"`)
    }

    const uiId = settings().ui ?? "tui"
    const ui = getUi(uiId)
    if (!ui) throw new Error(`unknown ui: ${uiId}`)
    await ui.start({ resume: summary })
  },
}

export function registerSessionClis(): void {
  registerCli(resumeCli)
}
