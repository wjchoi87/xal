import type { AgentSession } from "../agent/agent-session"
import type { UserInput } from "../providers/types"

export interface SelectOption<T> {
  label: string
  detail: string
  note?: string
  active?: boolean
  value: T
}

export interface SelectRequest<T> {
  options: SelectOption<T>[]
  search?: string
}

export interface CommandContext {
  session: AgentSession
  print(line: string): void
  busy(label?: string): void
  select<T>(request: SelectRequest<T>): Promise<T | undefined>
  restore(input: UserInput): void
  askSecret(question: string): Promise<string | undefined>
}

export interface Command {
  name: string
  describe: string
  hidden?: boolean
  run(args: string[], ctx: CommandContext): Promise<void>
}
