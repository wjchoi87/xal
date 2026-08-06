import type { Cli } from "./types"

export const modelsCli: Cli = {
  name: "models",
  usage: "models <target>",
  describe: "list available models",
  hidden: true,
}
