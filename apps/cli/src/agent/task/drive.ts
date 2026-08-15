import { runningProcessJobs, type BackgroundProcessJob } from "../../background/jobs"
import type { UserInput } from "../../providers/types"
import type { AgentEvent } from "../events"
import type { AgentSession } from "../session/session"

export type TaskDriveOutcome =
  { status: "completed"; report: string } | { status: "failed"; error: string } | { status: "interrupted" }

type TaskTurnEnd = { status: "completed" } | { status: "failed"; error: string } | { status: "interrupted" }

function runningJobsNotice(running: BackgroundProcessJob[]): string {
  const listing = running.map((job) => `- ${job.id}: ${job.command.split("\n", 1)[0]}`).join("\n")
  return [
    "<system-notice>",
    "Your response is not final while managed background jobs are still running:",
    listing,
    "Collect their results with job_output (pass wait to block), stop servers and watchers with job_kill, and finish only after every job has settled. Your final report must account for their results.",
    "</system-notice>",
  ].join("\n")
}

export async function driveTaskToQuiescence(
  child: AgentSession,
  input: UserInput,
  handle: (event: AgentEvent) => void,
  signal: AbortSignal,
): Promise<TaskDriveOutcome> {
  const turns: TaskTurnEnd[] = []
  let candidate = ""
  let idle = false
  let waiter: (() => void) | undefined

  const wake = (): void => waiter?.()
  const wait = (): Promise<void> =>
    new Promise((resolve) => {
      const settle = (): void => {
        signal.removeEventListener("abort", settle)
        if (waiter === settle) waiter = undefined
        resolve()
      }
      waiter = settle
      signal.addEventListener("abort", settle)
    })

  const unsubscribe = child.subscribe((event) => {
    handle(event)
    switch (event.type) {
      case "assistant_message":
        candidate = event.text
        break
      case "background_results":
        candidate = ""
        break
      case "state_changed":
        idle = event.state === "idle"
        if (idle) wake()
        break
      case "turn_ended":
        turns.push({ status: "completed" })
        wake()
        break
      case "turn_failed":
        turns.push({ status: "failed", error: event.message })
        wake()
        break
      case "turn_interrupted":
        turns.push({ status: "interrupted" })
        wake()
        break
      case "plan_updated":
      case "task_list_updated":
      case "session_started":
      case "session_replay_finished":
      case "session_title_changed":
      case "workspace_changed":
      case "mode_changed":
      case "model_changed":
      case "thinking_changed":
      case "user_message":
      case "conversation_rewound":
      case "conversation_redone":
      case "tool_call_updated":
      case "hook_started":
      case "hook_finished":
      case "queue_changed":
      case "queue_flushed":
      case "text_delta":
      case "reasoning_summary_delta":
      case "reasoning_delta":
      case "reasoning_summary":
      case "retry_scheduled":
      case "approval_requested":
      case "elicitation_requested":
      case "elicitation_resolved":
      case "tool_started":
      case "tool_updated":
      case "shell_finished":
      case "tool_finished":
      case "compacted":
      case "error":
        break
    }
  })

  try {
    if (!child.send(input)) return { status: "failed", error: "task session did not accept the prompt" }
    let noticeSent = false
    while (true) {
      if (turns.length === 0) {
        if (signal.aborted) return { status: "interrupted" }
        await wait()
        continue
      }
      const turn = turns.shift()!
      if (turn.status === "failed") return { status: "failed", error: turn.error }
      if (turn.status === "interrupted") return { status: "interrupted" }
      while (!idle && !signal.aborted) await wait()
      if (signal.aborted) return { status: "interrupted" }
      if (turns.length > 0) continue
      if (!child.hasPendingAsyncWork()) {
        const report = candidate.trim()
        if (report) return { status: "completed", report }
        return { status: "failed", error: "completed without a final report" }
      }
      if (!noticeSent) {
        const running = runningProcessJobs(child.id)
        if (running.length > 0) {
          noticeSent = true
          child.send({ text: runningJobsNotice(running), images: [] })
        }
      }
    }
  } finally {
    unsubscribe()
  }
}
