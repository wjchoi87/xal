export interface CliContext {
  print(line: string): void
  error(line: string): void
  ask(question: string): Promise<string>
  askSecret(question: string): Promise<string | undefined>
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
  args: string[]
}
