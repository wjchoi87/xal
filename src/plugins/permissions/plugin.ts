import { asStringArray } from "../../lib/json"
import { loadRememberedRules, setUserRules } from "../../permissions/rules"
import type { PermissionMode } from "../../permissions/types"
import type { Plugin } from "../types"

const modeGuidance: Record<PermissionMode, string> = {
  build: "",
  plan: "Plan mode is active. Read-only tools may be used for investigation, but writes, edits, and shell commands that are not read-only are refused before they run. Never retry a refused action.",
  auto: "Approvals are automatic for routine actions, so act instead of narrating what you are about to do. Actions the user marked as sensitive still require confirmation.",
  yolo: "Every action is pre-approved and runs without confirmation. Be correspondingly careful: prefer the narrowest command that does the job, and never run destructive operations the user did not ask for.",
}

const plugin: Plugin = {
  name: "permissions",
  register(ctx) {
    setUserRules({
      allow: asStringArray(ctx.config.allow),
      ask: asStringArray(ctx.config.ask),
      deny: asStringArray(ctx.config.deny),
    })
    ctx.registerPrompt({
      id: "permissions",
      text: (prompt) => modeGuidance[prompt.mode],
    })
  },
  async bootstrap() {
    await loadRememberedRules()
  },
}

export default plugin
