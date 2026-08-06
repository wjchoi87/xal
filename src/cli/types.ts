export interface CliContext {
  print(line: string): void
}

export interface Cli {
  name: string
  describe: string
  usage?: string
  hidden?: boolean
  run?(args: string[], ctx: CliContext): Promise<void>
}

export interface ResolvedCli {
  cli: Cli
  path: string[]
  args: string[]
}
