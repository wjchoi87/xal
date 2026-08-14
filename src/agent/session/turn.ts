import { runTurnEndHooks, type HookReporter } from "../../hooks/registry"
import type { HookContext } from "../../hooks/types"
import type { JsonObject } from "../../lib/json"
import type { Provider, ThinkingEffort, ToolCallItem, UserInput } from "../../providers/types"
import { TOOL_FAILED_PREFIX } from "../../tools/output"
import type { ToolEvent } from "../../tools/types"
import type { AgentEvent, AgentState } from "../events"
import type { HistoryItem } from "../history"
import { ToolLoopDetector } from "./loop-detection"
import type { OutputContract } from "./output-contract"
import { directShellCommand } from "./queue"
import { streamProviderTurn, type StreamRoundHost } from "./stream"
import type { TurnUsage } from "./types"
import { ToolCallRunner, type PreparedToolCall, type ToolCallEntry, type ToolCallOutcome } from "./tool-runner"

export interface TurnHost {
  readonly toolRunner: ToolCallRunner
  readonly hookReporter: HookReporter
  outputContract(): OutputContract | undefined
  queuedPromptNext(): boolean
  asyncResultsQueued(): boolean
  emit(event: AgentEvent): void
  setState(state: AgentState): void
  pushItem(item: HistoryItem): void
  publishToolEvent(event: ToolEvent): void
  hookContext(signal: AbortSignal): HookContext
  streamRound(usage: TurnUsage): StreamRoundHost
  drainBackgroundResults(): boolean
  drainQueue(signal: AbortSignal): Promise<boolean>
  autoCompact(signal: AbortSignal, provider: Provider, model: string): Promise<void>
  beginCheckpoint(messageId: string, input: UserInput): Promise<void>
  stopAcceptingInput(): void
  drainTurnEndEvents(): ToolEvent[]
}

export async function runTurn(
  host: TurnHost,
  signal: AbortSignal,
  provider: Provider,
  model: string,
  thinking: ThinkingEffort | undefined,
  usage: TurnUsage,
): Promise<void> {
  const toolLoops = new ToolLoopDetector()

  while (true) {
    if (host.drainBackgroundResults()) toolLoops.reset()
    await host.autoCompact(signal, provider, model)
    if (signal.aborted) {
      host.emit({ type: "turn_interrupted" })
      return
    }
    if (await host.drainQueue(signal)) toolLoops.reset()

    host.setState("streaming")
    const round = host.streamRound(usage)
    const items = await streamProviderTurn(round, signal, provider, model, thinking)
    if (!items) return

    round.buffer.flush()
    for (const item of items) host.pushItem(item)

    const toolCalls = items.filter((item): item is ToolCallItem => item.type === "tool_call")
    if (toolCalls.length === 0) {
      if (host.queuedPromptNext()) continue
      if (host.asyncResultsQueued()) continue
      const contract = host.outputContract()
      if (contract) {
        const correction = contract.missing()
        if (contract.exhausted) throw contract.failure()
        host.pushItem({ type: "user_message", text: correction, images: [] })
        continue
      }
      const final = items.findLast((item) => item.type === "assistant_message")
      await endTurn(host, usage, final?.type === "assistant_message" ? final.text : undefined, signal)
      return
    }

    let loopError: Error | undefined
    let requiresContinuation = false
    let sharedEntries: ToolCallEntry[] = []
    for (const [index, call] of toolCalls.entries()) {
      const entry = await host.toolRunner.applyBeforeToolHook(call, signal)
      if (host.toolRunner.concurrency(entry) === "shared") {
        sharedEntries.push(entry)
        continue
      }

      if (sharedEntries.length > 0) {
        const outcome = await host.toolRunner.runBatch(
          { concurrency: "shared", entries: sharedEntries },
          signal,
          toolLoops,
        )
        loopError = outcome.error
        requiresContinuation ||= outcome.requiresContinuation
        sharedEntries = []
        const stopReason = host.toolRunner.stopReason(loopError, signal)
        if (stopReason) {
          host.toolRunner.finishSkippedEntry(entry, stopReason)
          for (const remaining of toolCalls.slice(index + 1)) host.toolRunner.finishSkippedCall(remaining, stopReason)
          break
        }
      }

      const outcome = await host.toolRunner.runBatch({ concurrency: "exclusive", entries: [entry] }, signal, toolLoops)
      loopError = outcome.error
      requiresContinuation ||= outcome.requiresContinuation
      const stopReason = host.toolRunner.stopReason(loopError, signal)
      if (!stopReason) continue
      for (const remaining of toolCalls.slice(index + 1)) host.toolRunner.finishSkippedCall(remaining, stopReason)
      break
    }
    if (sharedEntries.length > 0) {
      const outcome = await host.toolRunner.runBatch(
        { concurrency: "shared", entries: sharedEntries },
        signal,
        toolLoops,
      )
      loopError = outcome.error
      requiresContinuation ||= outcome.requiresContinuation
    }
    if (loopError) throw loopError
    const contract = host.outputContract()
    if (contract?.output) {
      if (host.queuedPromptNext() || host.asyncResultsQueued()) {
        contract.reset()
        continue
      }
      await endTurn(host, usage, contract.output, signal)
      return
    }
    if (contract?.exhausted) throw contract.failure()

    if (signal.aborted) {
      host.emit({ type: "turn_interrupted" })
      return
    }

    if (!requiresContinuation && !host.queuedPromptNext() && !host.asyncResultsQueued()) {
      const final = items.findLast((item) => item.type === "assistant_message")
      if (final?.type === "assistant_message") {
        await endTurn(host, usage, final.text, signal)
        return
      }
    }
  }
}

export async function runDirectShell(host: TurnHost, input: UserInput, signal: AbortSignal): Promise<void> {
  const command = directShellCommand(input)
  if (command === undefined) throw new Error("direct shell received a regular prompt")
  const messageId = crypto.randomUUID()
  const requestedCall: ToolCallItem = {
    type: "tool_call",
    callId: `direct-shell-${crypto.randomUUID()}`,
    name: "bash",
    args: { command },
  }

  let outcome: ToolCallOutcome | undefined
  let prepared: PreparedToolCall | undefined
  if (!command) {
    outcome = host.toolRunner.outcome(requestedCall, "", false, `${TOOL_FAILED_PREFIX}shell command is empty`)
  } else {
    const entry = await host.toolRunner.applyBeforeToolHook(requestedCall, signal, false)
    if (entry.type === "outcome") {
      outcome = entry.outcome
    } else {
      const preparation = await host.toolRunner.prepare(entry.call, signal)
      if (preparation.type === "outcome") outcome = preparation.outcome
      else prepared = preparation.prepared
    }
  }

  await host.beginCheckpoint(messageId, input)
  if (prepared) outcome = await host.toolRunner.execute(prepared, signal)
  if (!outcome) throw new Error("direct shell did not produce an outcome")

  const executed = outcome.call.args.command
  const executedCommand = typeof executed === "string" ? executed.trim() : command

  const finished: Extract<AgentEvent, { type: "shell_finished" }> = {
    type: "shell_finished",
    messageId,
    callId: outcome.call.callId,
    input: input.text,
    command: executedCommand,
    output: outcome.output,
    readOnly: outcome.readOnly,
    ...(outcome.execution ? { execution: outcome.execution } : {}),
    ...(outcome.denial ? { denial: outcome.denial } : {}),
  }
  host.emit(finished)
  host.pushItem({
    type: "direct_shell",
    messageId: finished.messageId,
    callId: finished.callId,
    input: finished.input,
    command: finished.command,
    output: finished.output,
    readOnly: finished.readOnly,
    ...(finished.denial ? { denial: finished.denial } : {}),
  })
  for (const event of outcome.events) host.publishToolEvent(event)

  if (signal.aborted) {
    host.emit({ type: "turn_interrupted" })
    return
  }
  await endTurn(host, {}, outcome.output, signal)
}

async function endTurn(
  host: TurnHost,
  usage: TurnUsage,
  output: string | JsonObject | undefined,
  signal: AbortSignal,
): Promise<void> {
  host.stopAcceptingInput()
  await runTurnEndHooks(
    {
      ...(output === undefined ? {} : { output }),
      ...(usage.turn ? { usage: usage.turn } : {}),
      ...(usage.context ? { context: usage.context } : {}),
    },
    host.hookContext(signal),
    host.hookReporter,
  )
  for (const event of host.drainTurnEndEvents()) host.publishToolEvent(event)
  host.emit({
    type: "turn_ended",
    usage: usage.turn,
    context: usage.context,
    ...(typeof output === "string" || output === undefined ? {} : { output }),
  })
}
