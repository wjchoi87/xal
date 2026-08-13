import { registerPrompt } from "../agent/prompt"
import type { Settings } from "../config/settings"
import { setUserRules } from "./rules"
import type { PermissionMode } from "./types"

const modeGuidance: Record<PermissionMode, string> = {
  build: "",
  plan: "Plan mode is active. Read-only tools may be used for investigation, but writes, edits, and shell commands that are not read-only are refused before they run. Never retry a refused action.",
  auto: "Approvals are automatic for routine actions, so act instead of narrating what you are about to do. Actions the user marked as sensitive still require confirmation.",
  yolo: "Every action is pre-approved and runs without confirmation. Be correspondingly careful: prefer the narrowest command that does the job, and never run destructive operations the user did not ask for.",
}

const subagentModeGuidance: Record<PermissionMode, string> = {
  build: "",
  plan: "This is a read-only delegation. Use only read-only tools, make no workspace changes, and return your findings to the primary agent.",
  auto: "This delegation may modify the workspace. Routine actions run automatically, but any action that still requires separate approval will be denied.",
  yolo: "This delegation inherits the parent's pre-approved mode. Be correspondingly careful: prefer the narrowest action that completes the assigned task.",
}

export function registerPermissions(settings: Settings): void {
  setUserRules(settings.permissions)
  registerPrompt({
    id: "permissions",
    text: (prompt) => (prompt.kind === "subagent" ? subagentModeGuidance[prompt.mode] : modeGuidance[prompt.mode]),
  })
}
