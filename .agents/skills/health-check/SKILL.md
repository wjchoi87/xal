---
name: health-check
description: Analyze a Tack profiler file (~/.tack/profiler/*.jsonl) to extract harness bugs, hidden failures, and performance problems from a profiled run.
---

# Profile Health Check

Tack records a profile when launched with `ENABLE_PROFILER=1`. The goal of this analysis is to find real harness bugs that the model may have masked by recovering: a failed tool, a dead sub-agent, or a swallowed provider error can look like a successful session because the model routed around it.

## Input

- The user input is the path to a profiler file. If empty, use the newest file in `~/.tack/profiler/`.
- The file name is the primary session id; the matching conversation is in `~/.tack/sessions/<project-slug>/<session-id>.jsonl`.

## File format

One JSON object per line, ordered by time. Every line has `at` (epoch ms) and `type`:

- `run_started` `{version, pid, argv}` — an app run began. A file can contain several runs (resumed sessions append); analyze each run separately.
- `session_created` `{sessionId, kind, provider, model, cwd}` — `kind` is `primary` or `subagent`. Every sub-agent gets one.
- `agent_event` `{sessionId, kind, event}` — one AgentEvent (see `src/agent/events.ts`): user_message, state_changed, tool_started, tool_finished, approval_requested, retry_scheduled, hook_finished, compacted, turn_ended, turn_failed, turn_interrupted, error, and more.
- `first_delta` `{sessionId, kind, delta}` — the first streamed output of a stream round. Other streaming deltas are omitted; full text still arrives as assistant_message and reasoning_summary events.
- `app_event` `{event}` — plugin registration and bootstrap results.
- `job_created` / `job_finished` `{jobId, detail}` — background jobs (sub-agents, background bash).

## Failure markers

Extract every occurrence of these; they are the bugs and incidents:

- `turn_failed` — the turn died; the message says why. If no `retry_scheduled` appeared earlier in the same turn, the error was classified non-retryable or arrived mid-stream — judge whether it should have been retried (transient errors like overload, rate limit, 5xx should be).
- `tool_finished` with a `denial` field (`user`, `policy`, `plan`, `hook`) or output starting with `Tool failed:` or `Tool output could not be saved`.
- `job_finished` whose detail starts with `failed:`, or is `interrupted`, or `completed without a final report`.
- `hook_finished` with action `failed` or `blocked`.
- `error` events — non-fatal errors surfaced to the user (compaction failures, session-save failures).
- `app_event` with non-empty `failures`.
- A `user_message` whose turn never reaches `turn_ended` — the turn failed or was interrupted.

## Masked failures

The most valuable findings are failures the model recovered from. After listing raw failures, check what happened next:

- A denied or failed tool followed by the model reaching the same goal another way — capability gap or bug, even though the session succeeded.
- A failed sub-agent job whose task the primary session then redid itself.
- Repeated denials of the same tool in read-only sub-agents — the delegation may lack a capability it legitimately needs.
- Loop-steering outputs (`Repeated tool call blocked`) — the model was stuck before the harness intervened.

## Performance

- Tool duration: pair `tool_started` and `tool_finished` by `callId`.
- Time to first output: `state_changed` to `streaming`, then the next `first_delta` in the same session.
- Turn duration: `user_message` to `turn_ended`; token usage and context size are only on `turn_ended`.
- Approval wait: `approval_requested` to the matching `tool_started` or denied `tool_finished`.
- Flag outliers, not averages: the slowest tools, the longest waits, turns that burned tokens without progress.

## Report

- Findings ordered by severity. Each one: what happened, evidence (timestamps and records), and a root-cause hypothesis pointing into the Tack source when possible.
- Separate three categories: Tack bugs, provider or environment issues, and model behavior issues.
- End with a verdict: did the harness work this run, and what should be fixed first.
