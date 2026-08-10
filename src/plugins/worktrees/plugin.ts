import type { Plugin } from "../types"
import { worktreeEnterTool, worktreeExitTool, worktreeRemoveTool } from "./tools"

const plugin: Plugin = {
  name: "worktrees",
  register(ctx) {
    ctx.registerTool(worktreeEnterTool)
    ctx.registerTool(worktreeExitTool)
    ctx.registerTool(worktreeRemoveTool)
    ctx.registerPermissionRules({
      ask: ["worktree_exit(remove force)", "worktree_remove(* force)"],
    })
  },
}

export default plugin
