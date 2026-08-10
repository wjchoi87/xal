import { createSession } from "../../agent/compose"
import type { AgentSession } from "../../agent/agent-session"
import type { AgentEvent } from "../../agent/events"
import { appInfo } from "../../app-info"
import type { Cli } from "../../cli/types"
import { describeError } from "../../lib/error"
import { isPermissionMode, permissionModes, type PermissionMode } from "../../permissions/types"
import type { Usage } from "../../providers/types"

type OutputFormat = "text" | "json" | "jsonl"
type RunStatus = "completed" | "failed" | "interrupted"

interface RunOptions {
  format: OutputFormat
  mode: PermissionMode
  provider?: string
  model?: string
  prompt: string[]
  help: boolean
}

interface RunOutcome {
  status: RunStatus
  response: string
  usage?: Usage
  context?: Usage
  error?: string
}

interface RunResult extends RunOutcome {
  sessionId: string
  provider: string
  model: string
}

interface SetupFailure {
  status: "failed"
  error: string
}

function usage(): string {
  return `${appInfo.name} run [--format text|json|jsonl] [--mode ${permissionModes.join("|")}] [--provider id] [--model id] [prompt]`
}

function optionValue(args: string[], index: number, option: string): string {
  const value = args[index + 1]
  if (!value || value.startsWith("--")) throw new Error(`${option} expects a value`)
  return value
}

function isOutputFormat(value: string): value is OutputFormat {
  return value === "text" || value === "json" || value === "jsonl"
}

function parseArgs(args: string[]): RunOptions {
  const options: RunOptions = { format: "text", mode: "build", prompt: [], help: false }

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    switch (arg) {
      case "--help":
      case "-h":
        options.help = true
        break
      case "--format": {
        const value = optionValue(args, index, arg)
        if (!isOutputFormat(value)) throw new Error("--format expects one of: text, json, jsonl")
        options.format = value
        index++
        break
      }
      case "--mode": {
        const value = optionValue(args, index, arg)
        if (!isPermissionMode(value)) throw new Error(`--mode expects one of: ${permissionModes.join(", ")}`)
        options.mode = value
        index++
        break
      }
      case "--provider":
        options.provider = optionValue(args, index, arg)
        index++
        break
      case "--model":
        options.model = optionValue(args, index, arg)
        index++
        break
      case "--":
        options.prompt.push(...args.slice(index + 1))
        return options
      default:
        if (arg.startsWith("-")) throw new Error(`unknown run option: ${arg}`)
        options.prompt.push(arg)
        break
    }
  }

  return options
}

function printHelp(print: (line: string) => void): void {
  print(`usage: ${usage()}`)
  print("")
  print("Run one agent turn without starting the TUI.")
  print("")
  print("  --format text|json|jsonl  final text, one JSON result, or live JSONL events")
  print(`  --mode ${permissionModes.join("|")}  permission mode (default: build)`)
  print("  --provider id             override the configured provider")
  print("  --model id                override the configured model")
  print("")
  print("When prompt is omitted, it is read from standard input.")
}

async function readPrompt(parts: string[]): Promise<string> {
  const inline = parts.join(" ").trim()
  if (inline) return inline
  if (process.stdin.isTTY) throw new Error(`usage: ${usage()}`)
  const piped = (await Bun.stdin.text()).trim()
  if (!piped) throw new Error("prompt from standard input was empty")
  return piped
}

function printJson(print: (line: string) => void, value: AgentEvent | RunResult | SetupFailure): void {
  print(JSON.stringify(value))
}

function setFailureExitCode(code = 1): void {
  if (process.exitCode === undefined || process.exitCode === 0) process.exitCode = code
}

function reportSetupFailure(
  format: OutputFormat,
  message: string,
  print: (line: string) => void,
  error: (line: string) => void,
): void {
  if (format === "text") error(message)
  if (format === "json") printJson(print, { status: "failed", error: message })
  if (format === "jsonl") {
    const event: AgentEvent = { type: "error", message }
    printJson(print, event)
  }
  setFailureExitCode()
}

function runSession(
  session: AgentSession,
  prompt: string,
  format: OutputFormat,
  print: (line: string) => void,
  error: (line: string) => void,
): Promise<RunOutcome> {
  let response = ""
  let settled = false
  let unsubscribe = (): void => {}

  return new Promise((resolve) => {
    const finish = (outcome: Omit<RunOutcome, "response">): void => {
      if (settled) return
      settled = true
      unsubscribe()
      resolve({ ...outcome, response })
    }

    unsubscribe = session.subscribe((event) => {
      if (format === "jsonl") printJson(print, event)

      switch (event.type) {
        case "assistant_message":
          response = event.text
          break
        case "approval_requested": {
          const message = "This action needed approval but the session is headless, so it was not run."
          if (format !== "jsonl") error(`${message} Rerun with --mode auto to allow it.`)
          session.deny("policy", message)
          break
        }
        case "retry_scheduled":
          if (format !== "jsonl") {
            error(
              `[retrying in ${Math.ceil(event.delayMs / 1_000)}s · attempt ${event.attempt}/${event.maxAttempts}] ${event.message}`,
            )
          }
          break
        case "turn_ended":
          finish({ status: "completed", usage: event.usage, context: event.context })
          break
        case "turn_failed":
          finish({ status: "failed", error: event.message })
          break
        case "turn_interrupted":
          finish({ status: "interrupted" })
          break
        case "error":
          if (format !== "jsonl") error(event.message)
          break
        default:
          break
      }
    })

    if (!session.send({ text: prompt, images: [] })) {
      finish({ status: "failed", error: "session did not accept the prompt" })
    }
  })
}

function result(outcome: RunOutcome, session: AgentSession): RunResult {
  return {
    status: outcome.status,
    sessionId: session.id,
    provider: session.currentProvider.id,
    model: session.currentModel,
    response: outcome.response,
    ...(outcome.usage ? { usage: outcome.usage } : {}),
    ...(outcome.context ? { context: outcome.context } : {}),
    ...(outcome.error ? { error: outcome.error } : {}),
  }
}

export const runCli: Cli = {
  name: "run",
  usage: "run [prompt]",
  describe: "run one prompt without the TUI",
  async run(args, ctx) {
    const options = parseArgs(args)
    if (options.help) {
      printHelp(ctx.print)
      return
    }

    let prompt: string
    try {
      prompt = await readPrompt(options.prompt)
    } catch (error) {
      reportSetupFailure(options.format, describeError(error), ctx.print, ctx.error)
      return
    }

    let session: AgentSession
    try {
      const setup = await createSession({
        provider: options.provider,
        model: options.model,
        interactive: false,
      })
      session = setup.session
    } catch (error) {
      reportSetupFailure(options.format, describeError(error), ctx.print, ctx.error)
      return
    }

    session.setMode(options.mode)
    if (options.format === "jsonl") {
      printJson(ctx.print, session.startEvent())
    }

    const interrupt = (): void => session.interrupt()
    process.once("SIGINT", interrupt)
    let outcome: RunOutcome
    try {
      outcome = await runSession(session, prompt, options.format, ctx.print, ctx.error)
    } finally {
      process.off("SIGINT", interrupt)
    }

    if (options.format === "text" && outcome.status === "completed") ctx.print(outcome.response)
    if (options.format === "text" && outcome.status === "failed") ctx.error(outcome.error ?? "turn failed")
    if (options.format === "json") printJson(ctx.print, result(outcome, session))

    if (outcome.status === "failed") setFailureExitCode()
    if (outcome.status === "interrupted") setFailureExitCode(130)
  },
}
