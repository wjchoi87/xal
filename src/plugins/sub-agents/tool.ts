import { AgentSession } from "../../agent/agent-session"
import type { AgentEvent } from "../../agent/events"
import { runAgentTurn } from "../../agent/run"
import { appendJobOutput, createJob, finishJob, stopJob } from "../../background/jobs"
import { backgroundTasksChanged, registerBackgroundTask, type BackgroundTaskState } from "../../background/registry"
import { describeError } from "../../lib/error"
import { asString } from "../../lib/json"
import type { PermissionMode } from "../../permissions/types"
import type { Usage } from "../../providers/types"
import { toolFailed } from "../../tools/output"
import type { SessionTool } from "../../tools/types"

type SubAgentAccess = "read" | "write"

interface ActivityState {
  streamedText: boolean
  activity: string
  toolCalls: Set<string>
  updatedCalls: Set<string>
  usage?: Usage
}

const MAX_TASK_LENGTH = 20_000
const UNAVAILABLE_APPROVAL = "Sub-agent actions that require separate approval are unavailable."

function taskFrom(args: Record<string, unknown>): string {
  const task = asString(args.task)?.trim()
  if (!task) throw new Error("task is required")
  if (task.length > MAX_TASK_LENGTH) throw new Error(`task must be at most ${MAX_TASK_LENGTH} characters`)
  return task
}

function accessFrom(args: Record<string, unknown>): SubAgentAccess {
  const access = asString(args.access)
  if (access === "read" || access === "write") return access
  throw new Error('access must be "read" or "write"')
}

function childMode(parent: PermissionMode, access: SubAgentAccess): PermissionMode {
  if (access === "read") return "plan"
  return parent === "yolo" ? "yolo" : "auto"
}

function toolActivity(tool: string, title: string): string {
  const detail = title.split("\n", 1)[0]?.trim()
  return detail ? `${tool}: ${detail}` : tool
}

function activity(event: AgentEvent, child: AgentSession, state: ActivityState, record: (text: string) => void): void {
  switch (event.type) {
    case "text_delta":
      state.streamedText = true
      state.activity = "Writing report…"
      record(event.text)
      break
    case "assistant_message":
      if (!state.streamedText) record(`${event.text}\n`)
      state.streamedText = false
      break
    case "tool_started": {
      state.toolCalls.add(event.callId)
      state.activity = toolActivity(event.tool, event.title)
      record(`\n> ${state.activity}\n`)
      break
    }
    case "tool_updated":
      state.updatedCalls.add(event.callId)
      record(event.text)
      break
    case "tool_finished": {
      state.toolCalls.add(event.callId)
      const failed = event.denial !== undefined || toolFailed(event.output)
      state.activity = `${failed ? "Failed" : "Finished"} ${toolActivity(event.tool, event.title)}`
      if (!state.updatedCalls.has(event.callId) && event.output) record(`${event.output}\n`)
      record(`${failed ? "x" : "✓"} ${event.tool}\n`)
      break
    }
    case "approval_requested":
      state.activity = `Denied approval for ${event.tool}`
      record(`\n${event.tool} requires unavailable approval and was denied.\n`)
      child.deny("policy", UNAVAILABLE_APPROVAL)
      break
    case "retry_scheduled":
      state.activity = `Retrying in ${Math.ceil(event.delayMs / 1_000)}s`
      record(`\nRetrying in ${Math.ceil(event.delayMs / 1_000)}s: ${event.message}\n`)
      break
    case "turn_failed":
      state.activity = "Failed"
      record(`\nSub-agent failed: ${event.message}\n`)
      break
    case "turn_interrupted":
      state.activity = "Interrupted"
      record("\nSub-agent interrupted.\n")
      break
    case "error":
      state.activity = event.message
      record(`\n${event.message}\n`)
      break
    case "state_changed":
      if (event.state === "streaming") {
        state.activity = "Thinking…"
        backgroundTasksChanged()
      }
      break
    case "turn_ended":
      state.activity = "Report ready"
      state.usage = event.usage
      backgroundTasksChanged()
      break
    case "plan_updated":
    case "task_list_updated":
    case "session_started":
    case "session_title_changed":
    case "mode_changed":
    case "model_changed":
    case "thinking_changed":
    case "user_message":
    case "queue_changed":
    case "queue_flushed":
    case "reasoning_summary_delta":
    case "reasoning_delta":
    case "reasoning_summary":
    case "elicitation_requested":
    case "elicitation_resolved":
    case "compacted":
      break
  }
}

export const subAgentTool: SessionTool = {
  name: "sub_agent",
  description:
    "Spawn a fresh one-shot agent for a self-contained task as a background job and return its job id immediately. Follow its progress and final report with job_output and stop it with job_kill. Read access is safe for parallel investigation. Write access may change the shared workspace, which you share with every write delegation.",
  parameters: {
    type: "object",
    properties: {
      task: {
        type: "string",
        minLength: 1,
        maxLength: MAX_TASK_LENGTH,
        description: "Complete self-contained assignment for the sub-agent",
      },
      access: {
        type: "string",
        enum: ["read", "write"],
        description: "Read-only investigation or permission to modify the shared workspace",
      },
    },
    required: ["task", "access"],
    additionalProperties: false,
  },
  prompt:
    "Use sub_agent to delegate bounded work that benefits from a fresh context; it returns a job id immediately and runs in the background while you continue. Make each task self-contained. Spawn independent delegations together, then collect each report with job_output (pass wait instead of polling) before you rely on or summarize its work. Write delegations share the workspace with you and each other, so give each one a disjoint scope and avoid editing the same files yourself while they run.",
  sessionAware: true,
  available(ctx) {
    return ctx.kind === "primary"
  },
  title(args) {
    return asString(args.task)?.trim() ?? ""
  },
  readOnly(args) {
    return asString(args.access) === "read"
  },
  concurrency() {
    return "shared"
  },
  async execute(args, ctx) {
    if (ctx.session.kind !== "primary") throw new Error("sub_agent is available only to primary sessions")
    const task = taskFrom(args)
    const access = accessFrom(args)
    if (access === "write" && ctx.session.mode === "plan") {
      throw new Error("write delegation is unavailable in plan mode")
    }

    const child = new AgentSession({
      kind: "subagent",
      provider: ctx.session.provider,
      model: ctx.session.model,
      modelInputModalities: ctx.session.modelInputModalities,
      thinking: ctx.session.thinking,
      interactive: false,
      persist: false,
    })
    child.setMode(childMode(ctx.session.mode, access))

    const job = createJob("agent", () => child.interrupt())
    const startedAt = Date.now()
    let finishedAt: number | undefined
    let state: BackgroundTaskState = { running: true }
    const activityState: ActivityState = {
      streamedText: false,
      activity: "Initializing…",
      toolCalls: new Set(),
      updatedCalls: new Set(),
    }
    const record = (text: string): void => appendJobOutput(job, text)
    registerBackgroundTask({
      kind: "agent",
      id: job.id,
      title: task,
      startedAt,
      role: "sub-agent",
      model: ctx.session.model,
      state: () => state,
      output: () => job.history,
      snapshot: () => ({
        activity: activityState.activity,
        elapsedMs: (finishedAt ?? Date.now()) - startedAt,
        toolCount: activityState.toolCalls.size,
        usage: activityState.usage,
      }),
      stop: () => stopJob(job),
    })

    void runAgentTurn(child, { text: task, images: [] }, (event) => activity(event, child, activityState, record))
      .then((outcome) => {
        finishedAt = Date.now()
        if (outcome.status === "interrupted") {
          activityState.activity = "Interrupted"
          state = { running: false, ok: false, detail: "interrupted" }
          finishJob(job, "interrupted")
          return
        }
        if (outcome.status === "failed") {
          activityState.activity = "Failed"
          state = { running: false, ok: false, detail: "failed" }
          finishJob(job, `failed: ${outcome.error}`)
          return
        }
        const report =
          typeof outcome.response === "string" ? outcome.response.trim() : JSON.stringify(outcome.response, null, 2)
        if (!report) {
          activityState.activity = "Failed"
          state = { running: false, ok: false, detail: "no report" }
          record("\nSub-agent completed without a final report.\n")
          finishJob(job, "completed without a final report")
          return
        }
        activityState.activity = "Report ready"
        state = { running: false, ok: true, detail: "reported" }
        finishJob(job, "completed — the report is the streamed text above")
      })
      .catch((error: unknown) => {
        finishedAt = Date.now()
        activityState.activity = "Failed"
        state = { running: false, ok: false, detail: "failed" }
        record(`\nSub-agent failed: ${describeError(error)}\n`)
        finishJob(job, `failed: ${describeError(error)}`)
      })

    return {
      output: `Started sub-agent ${job.id} (${access}) in the background. Read its progress and final report with job_output(${job.id}) — pass wait to block — and stop it with job_kill(${job.id}).`,
    }
  },
}
