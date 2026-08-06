export interface CliContext {
  print(line: string): void
}

export interface Cli {
  name: string
  describe: string
  usage?: string
  hidden?: boolean
  run(args: string[], ctx: CliContext): Promise<void>
}

const clis = new Map<string, Cli>()

export function registerCli(cli: Cli): void {
  clis.set(cli.name, cli)
}

export function getCli(name: string): Cli | undefined {
  return clis.get(name)
}

export function listClis(): Cli[] {
  return [...clis.values()]
}
