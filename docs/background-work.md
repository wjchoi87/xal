# Background work

The agent can run work in the background in two forms: task agents dispatched with the `task` tool and background processes started with `bash` `background:true`. Both kinds are tracked as background jobs, deliver their results back into the conversation automatically, and share one set of TUI surfaces.

## Task agents

The `task` tool dispatches a batch of up to 8 independent assignments. Each assignment becomes its own agent session that starts without conversation history: the batch's shared `context` plus the assignment text is everything it knows. The call returns agent ids immediately; up to `agents.maxConcurrent` agents run at once and the rest queue.

Each task declares its `access`:

- `read` — the agent runs in a read-only mode and cannot modify files.
- `write` — the agent inherits the parent's permission mode. With `isolation: "worktree"` it works in its own Git worktree and branch; otherwise it edits the shared checkout.

Dispatching any `write` task asks for approval. Sub-agents cannot ask for approval themselves; any action that would need it is denied automatically. Each agent runs until it produces a final report, reaches the `agents.timeoutMinutes` deadline, or exceeds its turn budget: after `agents.maxTurns` completed turns the agent is told to wrap up, and at 1.5× the budget its last report is returned as-is instead of running forever.

A finished agent's report is delivered into the parent conversation automatically as a system notice — no polling needed. Alongside the in-conversation result, every agent writes two durable files into the session directory:

- a Markdown task record (`agent-<id>-….md`) with the assignment, workspace, final report, and buffered transcript
- a full transcript log (`agent-<id>-….log`) written incrementally while the agent runs, so nothing is lost even if the process dies; logs cap at 64 MB and are marked `(capped)` past that

## Background processes

`bash` with `background:true` starts the command as a managed job and returns its id immediately. Output is captured into a bounded in-memory buffer (oldest middle dropped past ~400 KB, marked with `... N characters omitted ...`) and written completely to a `.log` file in the session directory. When the process exits, its result is delivered into the conversation automatically.

A running foreground `bash` command can be promoted to a background job at any moment with the `jobs.background` shortcut (default `ctrl+b`). The command keeps running, its output keeps flowing into the job, and the result is delivered when it exits. Killing a promoted command that ran in the persistent shell tears the shell session down; the next command starts a fresh one.

## Job tools

The model manages jobs with four tools:

| Tool         | Purpose                                                                                                     |
| ------------ | ----------------------------------------------------------------------------------------------------------- |
| `job_output` | Read new process output or collect an agent report explicitly; `wait` blocks up to 600s for output or exit. |
| `job_status` | Inspect one job or list all: queue state, activity, idle time, elapsed and queued time, remaining deadline. |
| `job_send`   | Queue guidance into a running task agent's current turn.                                                    |
| `job_kill`   | Stop a job. A process that ignores the graceful stop is hard-killed after 2 seconds.                        |

Stopping a job from the TUI is never silent: the result is marked `stopped by the user` and still delivered so the model knows what happened. A task agent remains unsettled until its runner has finished cleanup and saved its task record.

## TUI surfaces

- The status bar shows live counts (`2 agents · 1 job · …`) whenever background work exists.
- Running agents are summarized above the composer with their current activity, tool count, and context tokens; queued agents show `queued <time>` instead of a running clock.
- The navigator at the bottom lists every job: running rows first, then finished rows (newest first). Finished rows stay for 5 minutes so results remain reviewable, and jobs started by a sub-agent are attributed with `⟨agent-id⟩`.

Open the navigator with `/agents` (alias `/jobs`), the `agents.open` shortcut (default `ctrl+x ctrl+a`), or by pressing `↓` with an empty composer.

Navigator keys:

| Key       | Action                                            |
| --------- | ------------------------------------------------- |
| `↑` `↓`   | Move between rows                                 |
| `enter`   | Open the viewer for the selected agent or process |
| `tab`     | Toggle an inline preview of the last output lines |
| `x` / `k` | Stop a running job, or dismiss a finished row     |
| `esc`     | Close the viewer, collapse the preview, or leave  |

The viewer takes over the screen and follows the job's output live. While it is open, `↑`/`↓` keep moving the selection in the list below and `enter` switches the viewer to the selected job (or closes it on the viewed row), so you can hop between running agents without leaving the viewer. `pgup`/`pgdn` scroll the transcript, `home` jumps to the top, and `end` returns to the bottom and resumes following (scrolling up pauses following and shows `· paused`). For a running agent, `i` opens a steering input — type guidance and press `enter` to queue it into the agent's current turn; the transcript marks it as `User guidance`.

`agents.stop-all` (default `ctrl+x ctrl+k`) stops every running agent at once.

## Configuration

| Option                  | Default | Range   | Description                                             |
| ----------------------- | ------- | ------- | ------------------------------------------------------- |
| `agents.maxConcurrent`  | `4`     | `1–8`   | Task agents running at once; further tasks queue.       |
| `agents.timeoutMinutes` | `10`    | `1–60`  | Hard deadline per task agent.                           |
| `agents.maxTurns`       | `24`    | `1–100` | Soft turn budget; agents are told to wrap up beyond it. |

See [Configuration](/docs/configs) for where these options live and how project and user configuration merge.
