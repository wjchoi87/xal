import { clearCommand } from "./clear"
import { connectCommand } from "./connect"
import { modelCommand } from "./model"
import { resumeCommand } from "./resume"
import type { Command } from "./types"

export const builtinCommands: Command[] = [connectCommand, modelCommand, clearCommand, resumeCommand]
