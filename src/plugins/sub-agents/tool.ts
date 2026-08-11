import { AgentSession } from "../../agent/agent-session"
import type { AgentEvent } from "../../agent/events"
import { runAgentTurn } from "../../agent/run"
import { appendAgentTranscript, createAgentJob, finishAgentJob, setAgentActivity, stopJob } from "../../background/jobs"
import { backgroundTasksChanged, registerBackgroundTask, type BackgroundTaskState } from "../../background/registry"
import { createManagedWorktree } from "../../git/worktrees"
import { describeError } from "../../lib/error"
import { asString } from "../../lib/json"
import { compactPath } from "../../lib/path"
import type { PermissionMode } from "../../permissions/types"
import { isThinkingEffort, type ThinkingEffort, type Usage } from "../../providers/types"
import { toolFailed } from "../../tools/output"
import type { SessionTool } from "../../tools/types"

type SubAgentAccess = "read" | "write"
type SubAgentIsolation = "shared" | "worktree"

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

function isolationFrom(args: Record<string, unknown>): SubAgentIsolation {
  const isolation = asString(args.isolation) ?? "shared"
  if (isolation === "shared" || isolation === "worktree") return isolation
  throw new Error('isolation must be "shared" or "worktree"')
}

function thinkingFrom(args: Record<string, unknown>): ThinkingEffort | undefined {
  if (args.thinking === undefined) return undefined
  if (isThinkingEffort(args.thinking)) return args.thinking
  throw new Error('thinking must be one of "none", "low", "medium", "high", "xhigh", or "max"')
}

function childMode(parent: PermissionMode, access: SubAgentAccess): PermissionMode {
  if (access === "read") return "plan"
  return parent === "yolo" ? "yolo" : "auto"
}

function toolActivity(tool: string, title: string): string {
  const detail = title.split("\n", 1)[0]?.trim()
  return detail ? `${tool}: ${detail}` : tool
}

function activity(
  event: AgentEvent,
  child: AgentSession,
  state: ActivityState,
  record: (text: string) => void,
  updateActivity: (value: string) => void,
): void {
  const previousActivity = state.activity
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
      state.usage = event.usage
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
    case "hook_finished":
      state.activity = `Hook ${event.hook}: ${event.event} ${event.action}`
      record(`\n> hook: ${event.hook} · ${event.event} · ${event.action} · ${event.elapsedMs}ms\n`)
      backgroundTasksChanged()
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
    case "workspace_changed":
    case "mode_changed":
    case "model_changed":
    case "thinking_changed":
    case "user_message":
    case "conversation_rewound":
    case "conversation_redone":
    case "tool_call_updated":
    case "hook_started":
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
  if (state.activity !== previousActivity) updateActivity(state.activity)
}

export const subAgentTool: SessionTool = {
  name: "sub_agent",
  description:
    "Spawn a fresh one-shot agent for a self-contained task as a background job and return its job id immediately. The agent sees nothing but the task text, works autonomously without asking questions, and its internal transcript is shown only in the background-task viewer. Collect its final report with job_output and stop it with job_kill. Write agents can use the shared workspace or a clean isolated Git worktree on their own branch.",
  parameters: {
    type: "object",
    properties: {
      task: {
        type: "string",
        minLength: 1,
        maxLength: MAX_TASK_LENGTH,
        description:
          "Complete self-contained assignment. The agent has no other context, so include the goal, relevant paths, constraints, how to verify the work, and what the final report must contain",
      },
      access: {
        type: "string",
        enum: ["read", "write"],
        description: "read runs a read-only investigation; write may modify files",
      },
      isolation: {
        type: "string",
        enum: ["shared", "worktree"],
        description:
          "shared uses the current workspace (default); worktree gives a write agent a clean checkout and branch",
      },
      thinking: {
        type: "string",
        enum: ["none", "low", "medium", "high", "xhigh", "max"],
        description:
          "Reasoning effort for the sub-agent. Defaults to yours; lower effort finishes bounded, well-specified tasks much faster",
      },
    },
    required: ["task", "access"],
    additionalProperties: false,
  },
  prompt:
    "Use sub_agent to delegate bounded, self-contained work that can run while you continue; do the work yourself when it is quick or when your very next step depends on its result. The agent sees only the task text, so state the goal, the relevant paths, whether to modify files or only investigate, how to verify the work, and exactly what the report must contain. Right-size each delegation with thinking: sub-agent time is dominated by how much it reasons and writes, so use lower effort for bounded tasks and reserve high effort for genuinely hard ones. Spawn independent delegations together, give shared write agents disjoint files, and use isolation:worktree when write work should not touch the current checkout — the result stays on its own branch until integrated or removed with worktree_remove. Never redo delegated work: continue non-overlapping tasks, then join each agent exactly once with job_output and a sufficient wait before you rely on or summarize its report. The background-task viewer shows progress without adding the transcript to your context.",
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
    const isolation = isolationFrom(args)
    if (access === "write" && ctx.session.mode === "plan") {
      throw new Error("write delegation is unavailable in plan mode")
    }
    if (isolation === "worktree" && access !== "write") {
      throw new Error("worktree isolation is available only to write delegations")
    }

    const worktree =
      isolation === "worktree" ? await createManagedWorktree(ctx.session.cwd, task, ctx.signal) : undefined

    const child = new AgentSession({
      kind: "subagent",
      cwd: worktree?.cwd ?? ctx.session.cwd,
      provider: ctx.session.provider,
      model: ctx.session.model,
      modelInputModalities: ctx.session.modelInputModalities,
      thinking: thinkingFrom(args) ?? ctx.session.thinking,
      interactive: false,
      persist: false,
      ...(access === "write" && !worktree ? { workspaceUndo: ctx.session.workspaceUndo, trackUndoPrompts: false } : {}),
    })
    child.setMode(childMode(ctx.session.mode, access))

    const job = createAgentJob("agent", () => child.interrupt())
    const startedAt = Date.now()
    let finishedAt: number | undefined
    let state: BackgroundTaskState = { running: true }
    const activityState: ActivityState = {
      streamedText: false,
      activity: "Initializing…",
      toolCalls: new Set(),
      updatedCalls: new Set(),
    }
    const record = (text: string): void => appendAgentTranscript(job, text)
    if (worktree) {
      record(`Isolated worktree: ${compactPath(worktree.path)}\nBranch: ${worktree.branch}\n\n`)
    }
    registerBackgroundTask({
      kind: "agent",
      id: job.id,
      title: task,
      startedAt,
      role: worktree ? "sub-agent · worktree" : "sub-agent",
      model: ctx.session.model,
      cwd: child.currentWorkingDirectory,
      state: () => state,
      output: () => job.transcript,
      snapshot: () => ({
        activity: activityState.activity,
        elapsedMs: (finishedAt ?? Date.now()) - startedAt,
        toolCount: activityState.toolCalls.size,
        usage: activityState.usage,
      }),
      stop: () => stopJob(job),
    })

    void runAgentTurn(child, { text: task, images: [] }, (event) =>
      activity(event, child, activityState, record, (value) => setAgentActivity(job, value)),
    )
      .then((outcome) => {
        finishedAt = Date.now()
        if (outcome.status === "interrupted") {
          activityState.activity = "Interrupted"
          state = { running: false, ok: false, detail: "interrupted" }
          setAgentActivity(job, activityState.activity)
          finishAgentJob(job, { status: "interrupted" }, "interrupted")
          return
        }
        if (outcome.status === "failed") {
          activityState.activity = "Failed"
          state = { running: false, ok: false, detail: "failed" }
          setAgentActivity(job, activityState.activity)
          finishAgentJob(job, { status: "failed" }, `failed: ${outcome.error}`)
          return
        }
        const report =
          typeof outcome.response === "string" ? outcome.response.trim() : JSON.stringify(outcome.response, null, 2)
        if (!report) {
          activityState.activity = "Failed"
          state = { running: false, ok: false, detail: "no report" }
          setAgentActivity(job, activityState.activity)
          record("\nSub-agent completed without a final report.\n")
          finishAgentJob(job, { status: "failed" }, "completed without a final report")
          return
        }
        activityState.activity = "Report ready"
        state = { running: false, ok: true, detail: "reported" }
        setAgentActivity(job, activityState.activity)
        finishAgentJob(
          job,
          { status: "completed", report },
          worktree ? `completed in ${worktree.branch} at ${compactPath(worktree.path)}` : "completed",
        )
      })
      .catch((error: unknown) => {
        finishedAt = Date.now()
        activityState.activity = "Failed"
        state = { running: false, ok: false, detail: "failed" }
        setAgentActivity(job, activityState.activity)
        record(`\nSub-agent failed: ${describeError(error)}\n`)
        finishAgentJob(job, { status: "failed" }, `failed: ${describeError(error)}`)
      })

    const workspace = worktree
      ? ` in ${compactPath(worktree.path)} on branch ${worktree.branch}. The checkout remains after completion; integrate it or remove it with worktree_remove.`
      : "."
    return {
      output: `Started sub-agent ${job.id} (${access}, ${isolation}) in the background${workspace} Join it once with job_output(${job.id}) and a sufficient wait to collect its final report, or stop it with job_kill(${job.id}).`,
    }
  },
}
