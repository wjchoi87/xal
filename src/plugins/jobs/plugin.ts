import type { Plugin } from "../types"
import { jobKillTool, jobOutputTool } from "./tools"

const plugin: Plugin = {
  name: "jobs",
  register(ctx) {
    ctx.registerTool(jobOutputTool)
    ctx.registerTool(jobKillTool)
  },
}

export default plugin
