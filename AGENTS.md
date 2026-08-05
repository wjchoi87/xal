# Agent Harnes

A terminal coding harness: an agentic TUI that integrates with AI providers to do real development work in your project. Built in small working increments — `0.0.x` releases grow feature by feature until `0.1.0`, which is **v0, the beta**.

## Vision

Customizable and extensible full coding harness that remains as small as possible and allows everyone to extend and change its behaviours.

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

- Customizable and Extensible by supporting plugins

## Conventions

- Early returns over nested conditions.
- Typed wire boundaries; narrow `unknown` with `lib/json` guards, never `as` casts.
- Typed event unions at seams; exhaustive switches.
- No code comments.
- No backward compatibility. only clean solutions.
- No tests.