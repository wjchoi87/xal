import { clearCommand } from "./clear"
import { connectCommand } from "./connect"
import { modelCommand } from "./model"
import { resumeCommand } from "./resume"
import { thinkingCommand } from "./thinking"
import type { Command } from "./types"

export const builtinCommands: Command[] = [connectCommand, modelCommand, thinkingCommand, clearCommand, resumeCommand]
