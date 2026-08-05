# Agent Harnes

A terminal coding harness: an agentic TUI that integrates with AI providers to do real development work in your project. Built in small working increments — `0.0.x` releases grow feature by feature until `0.1.0`, which is **v0, the beta**.

## Architecture

One sentence: **a headless agent core emits a typed, serializable, unidirectional event stream per session; UIs are subscribers; commands flow in through a narrow typed surface.**

```mermaid
sequenceDiagram
    actor Engineer
    participant Screen as Terminal screen (subscriber)
    participant Core as AgentSession (state machine)
    participant Model as Provider (AI model)
    participant Tools as Tool registry
    participant Memory as Session memory (event/item log)

    Engineer->>Screen: Ask for work
    Screen->>Core: session.send(text)

    loop Until the turn is complete
        Core->>Model: Conversation + tool definitions
        Model-->>Core: Streamed reply / tool request
        Core-->>Screen: AgentEvent stream (deltas, state changes)
        opt A tool is requested
            Core->>Core: Permission policy (mode)
            opt Policy says ask
                Core-->>Screen: approval_requested event
                Engineer->>Screen: y / n
                Screen->>Core: session.approve() / deny()
            end
            Core->>Tools: Execute approved action
            Tools-->>Core: Result
            Core->>Memory: Append items
        end
    end

    Core-->>Screen: turn_ended event
    Core->>Memory: Turn committed (persistable later)
```

### Principles

1. **AgentSession is the aggregate root.** It owns the conversation, the state machine (`idle → streaming → awaiting_approval → running_tool`), and turn orchestration. Nothing else runs turns.
2. **One typed event union per seam.** `AgentEvent` out of the session, `StreamEvent` out of providers, `WireSseEvent` out of the wire. Discriminated unions with exhaustive switches — adding a variant breaks compilation until every consumer handles it.
3. **Events are serializable (plain JSON data).** This is what makes session persistence, replay/resume, and a future server mode (events over SSE, TUI as remote client) cheap instead of rewrites.
4. **Commands in are method calls** (`send`, `approve`, `deny`, `interrupt`), not events. No global pub/sub bus — causality stays traceable.
5. **One-way dependencies:** `tui / commands → agent → providers / tools / permissions → config / lib`. The core never imports from the UI; any frontend (TUI, headless `ask`, tests, future server) drives the same core.
6. **Typed wire boundaries.** External data (provider APIs, models.dev, config files) is narrowed to internal types at the edge of the module that fetches it. Raw shapes and `as` casts never leak. Exception by design: conversation items stay verbatim (`ConversationItem`) because the backend requires exact replay.
7. **Registries as plugin seams.** Providers, tools, and commands register into maps; adding one never modifies consumers.
8. **App identity flows from `package.json → name`** — binary label, config dir (`~/.config/<name>/`), env vars, OAuth originator.


## Conventions

- Early returns over nested conditions.
- Typed wire boundaries; narrow `unknown` with `lib/json` guards, never `as` casts.
- Typed event unions at seams; exhaustive switches.
- No code comments.