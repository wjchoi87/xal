import { askCli } from "./ask"
import { connectCli } from "./connect"
import { modelsCli } from "./models"
import { resumeCli } from "./resume"
import type { Cli } from "./types"

export const builtinClis: Cli[] = [connectCli, modelsCli, resumeCli, askCli]
