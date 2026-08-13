import { registerTool } from "../tools/registry"
import { jobKillTool, jobOutputTool } from "./tools"

export function registerJobTools(): void {
  registerTool(jobOutputTool)
  registerTool(jobKillTool)
}
