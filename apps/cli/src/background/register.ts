import { registerTool } from "../tools/registry"
import { jobKillTool, jobOutputTool, jobSendTool, jobStatusTool } from "./tools"

export function registerJobTools(): void {
  registerTool(jobOutputTool)
  registerTool(jobKillTool)
  registerTool(jobStatusTool)
  registerTool(jobSendTool)
}
