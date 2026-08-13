# Optimize agent execution performance

## Objective

Reduce Tack's end-to-end time on real development tasks by reducing unnecessary provider round trips, repeated xhigh reasoning, and redundant context replay without making the agent shallower or weakening tool safety.

The reference workload is a read-only review of Muxy PR 1014 using `$code-review pr 1014`, `gpt-5.6-sol`, xhigh thinking, and the normal service tier.

This is primarily an agent-loop and tool-use efficiency problem. Do not spend time optimizing TUI rendering, startup, filesystem reads, or local tool execution unless new evidence contradicts the profiler.

## Baseline evidence

Benchmark transcripts:

- `/Users/saeed/Projects/agent-ts/discovery/benchmark/code-review/codex.txt`
- `/Users/saeed/Projects/agent-ts/discovery/benchmark/code-review/pi.txt`
- `/Users/saeed/Projects/agent-ts/discovery/benchmark/code-review/tack.txt`
- `opencode.txt` is empty and is not a valid comparison.

Tack profiler:

- `/Users/saeed/.tack/profiler/afee0e3f-4ae5-48d8-8f84-85709cb9ac5a.jsonl`

Raw comparison sessions, useful for counting provider rounds and tool operations:

- Codex: `/Users/saeed/.codex/sessions/2026/08/13/rollout-2026-08-13T17-05-50-019ffb71-8a67-7853-b033-ad06ce9d7136.jsonl`
- Pi: `/Users/saeed/.pi/agent/sessions/--Users-saeed-Projects-muxy--/2026-08-13T14-14-43-159Z_019ffb79-acd7-70f2-81f0-1fae11deb2a3.jsonl`

| Harness | Elapsed | Provider rounds | Tool operations |    Cumulative input | Output/reasoning |
| ------- | ------: | --------------: | --------------: | ------------------: | ---------------: |
| Codex   |   5m49s |              12 |              69 |   924K, 797K cached |            15.1K |
| Pi      |  11m04s |              43 |              90 | 4.28M, 4.09M cached |            20.2K |
| Tack    |  20m57s |              61 |             152 | 7.55M, 7.35M cached |            48.6K |

For Tack specifically:

- 1,249.8 of 1,261.0 seconds, 99.1%, was provider time.
- All tool batches together took 7.1 seconds.
- All 61 provider requests completed on attempt one.
- All 66 tool batches completed successfully.
- Time to first provider event totaled 332.4 seconds, averaging 5.45 seconds per round.
- The final context was about 170K tokens. Context size itself was not exceptional; replaying it across too many rounds was.
- The run made 79 `read`, 58 `grep`, 8 `bash`, 4 `update_tasks`, 2 `glob`, and 1 `skill` calls.
- 46 of 66 tool batches contained only one tool.
- There were only 44 unique read targets. `GhosttyTerminalNSView.swift` was read 9 times, `AppState.swift` 7 times, and `MuxyAPI.swift` 6 times.
- The last real evidence read was followed by 4m36s across three provider requests: update task state, update it again, then produce the final answer.

The benchmark sessions overlapped, so absolute wall times contain some concurrency noise. That does not explain the structural difference in provider rounds, tool operations, or generated tokens. Run future comparisons sequentially.

## Confirmed causes

### Primitive exploration creates too many provider continuations

`src/agent/agent-session.ts` correctly loops back through `streamRound` after tool results. The expensive behavior comes from making many dependent primitive calls, each of which requires another xhigh response.

Current tool guidance amplifies this:

- `src/plugins/files/read.ts` tells the model to use `read` instead of shell readers.
- `src/plugins/search/grep.ts` tells the model to start in files mode and then make another content-mode search.
- `src/tools/bash/tool.ts` tells the model to prefer dedicated tools even when a single read-only shell command could combine related inspection steps.

Parallel tool calling is already enabled in `src/plugins/openai-chatgpt/transport.ts` and works when all targets are known. It does not help when every result leads to another small search or read.

Codex's major advantage is composability: 11 orchestration calls performed 69 underlying commands, resulting in only 12 provider rounds. The solution for Tack should preserve its small, extensible architecture while making similarly dense inspection possible.

### Task tracking creates model rounds for UI bookkeeping

`src/tasks/tool.ts` asks the model to mark one step in progress at a time and complete it immediately, never in batches. Every tool result returns through the normal agent loop.

The benchmark made four task updates. Two consecutive updates at the end split final synthesis across three large xhigh responses. Task UI accuracy matters, but bookkeeping must not dominate task execution.

Do not hardcode special behavior for the `update_tasks` tool inside the generic agent loop. Keep the task plugin independent and find a clean seam if tool metadata or turn-end behavior needs to change.

### Explicit skills are loaded twice

`src/skills/invoke.ts` embeds the complete skill body into `modelText` for `$skill` invocation. `src/skills/tool.ts` simultaneously tells the model to call `skill` whenever the user names one.

The benchmark therefore received the full code-review skill in the initial message and then called `skill` to receive it again. This costs a provider round and keeps duplicate instructions in subsequent context.

Explicit invocations must make the skill available exactly once. Implicit skill selection must continue to support lazy loading. Supporting skill resources must remain discoverable.

## Work to perform

### 1. Establish reproducible metrics

- Read the profiler and raw sessions before changing code.
- Record provider rounds, provider wall time, tool batches, tool calls, cumulative input, cache-read input, output tokens, final context, and the time from the last evidence-producing tool to the final answer.
- Make only measurements that have a current consumer. A permanent benchmark helper is optional; do not add one unless it will be used by the validation workflow in this task.

### 2. Remove redundant control-plane rounds

- Fix explicit skill invocation so it does not trigger a second skill load.
- Reduce or eliminate provider continuations caused only by task-list state transitions.
- Preserve honest task state. Never mark work completed before it is actually complete.
- Keep generic agent-loop behavior generic. Prefer tool metadata, plugin-owned lifecycle behavior, or simpler prompt semantics over checking concrete tool names in core code.

### 3. Make exploration denser

Implement the smallest clean design that materially reduces provider rounds on the reference workload.

Evaluate these options against the existing architecture rather than implementing all of them by default:

- Allow read-only shell inspection to combine related searches and reads instead of always preferring primitive tools.
- Remove the forced two-stage files-then-content grep workflow and return useful context in one operation when requested.
- Improve structured exploration tools so the model can request related files, ranges, or searches together.
- Add a core composition mechanism only if simpler tool and prompt changes cannot approach the target. It must reuse registered tools, preserve permission evaluation and cancellation, report failures loudly, and avoid plugin-to-plugin dependencies.

Do not merely increase output limits or hide tool calls. The goal is fewer model continuations and less repeated reasoning while returning enough evidence for a correct result.

### 4. Tighten stopping behavior without reducing review quality

- Inspect changed files and their direct callers or lifecycle consumers first.
- Expand investigation when a concrete hypothesis requires it.
- Avoid repeatedly rereading the same broad files when a symbol search or targeted range can answer the question.
- Preserve the code-review skill's requirement to verify findings and avoid speculation.
- Do not introduce a hard tool or round cap that can silently truncate valid work.

### 5. Validate the implementation

- Do not add tests, following this repository's current instructions.
- Run `bun checks:fix` after modifying source files subject to formatting or linting.
- Run the exact reference review from `/Users/saeed/Projects/muxy` with `gpt-5.6-sol`, xhigh thinking, normal service tier, and profiling enabled.
- Ensure no competing benchmark is running.
- Capture a new transcript and profiler file.
- Compare the new final review with the baseline for evidence quality. A faster run is invalid if it skips the PR diff, ignores necessary surrounding code, invents findings, or weakens the selected skill's contract.
- If the first run is close to a target boundary, run one sequential confirmation rather than drawing a conclusion from noise.

## Acceptance criteria

Functional requirements:

- `$code-review pr 1014` applies the skill once and does not call the `skill` tool to reload the already injected package.
- Implicitly selected skills and supporting-file reads continue to work.
- Tool permission, cancellation, error propagation, redaction, recording, and profiler behavior remain intact.
- Task progress remains truthful without requiring consecutive provider rounds solely to change UI state.
- The final review remains grounded in the PR specification, diff, and relevant surrounding implementation.
- Plugins do not depend on one another.

Performance targets for the same reference workload:

- No more than 36 provider rounds, a reduction of at least 40% from 61.
- No more than 100 tool operations.
- No more than 30K output/reasoning tokens.
- No more than 4.5M cumulative input tokens.
- No more than one provider continuation after the last evidence-producing tool before the final answer.
- Target wall time at or below 12 minutes on a sequential normal-tier run. Treat structural metrics as more reliable than one wall-clock result.

If a target is missed, report exactly which rounds remain, what triggered them, and the next smallest root-cause change. Do not claim success based only on a subjective impression that the run feels faster.

## Scope boundaries

- Do not switch the benchmark to the fast or priority service tier.
- Do not lower thinking effort.
- Do not optimize by shortening or weakening the user's task or skill.
- Do not add provider concurrency for dependent turns.
- Do not pursue TUI rendering, startup, local filesystem, or tool-runtime micro-optimizations without profiler evidence.
- Do not add backward-compatibility paths.
- Do not add unused abstractions, speculative configuration, or a general scripting runtime unless the measured task requires it.
- Do not update `AGENTS.md`.

## Deliverable

Implement the root-cause fixes, run the required checks and benchmark, and report:

- The design chosen and why it is the smallest clean solution.
- Files changed.
- Before-and-after metrics for every acceptance target.
- Any target not met and the remaining cause.
- Quality differences observed in the final review.
