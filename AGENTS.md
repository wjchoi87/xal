# Tack

A terminal coding harness: an agentic TUI that integrates with AI providers to do real development work in your project. Built in small working increments — `0.0.x` releases grow feature by feature until `0.1.0`, which is **v0, the beta**.

## Vision

Customizable and extensible full coding harness that remains as small as possible and allows everyone to extend and change its behaviours.

## Architecture

One sentence: **a headless agent core emits a typed, serializable, unidirectional event stream per session; UIs are subscribers; commands flow in through a narrow typed surface; every feature — tools, providers, CLIs, prompt, policy, the TUI itself — is contributed through plugin registration.**

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
            Core->>Core: Policy rules (allow / deny / ask)
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

### CLI

`src/cli` owns the entry-point surface: `runCli(args, ctx)` dispatches, and the registry is seeded with the built-in roots so they exist the moment the module is imported — no bootstrap step, no ordering rule against plugin registration. A root without a `run` is a namespace that only prints its subcommands; plugins fill it in through `ctx.registerCli(cli, parent)`, and registering under a parent that does not exist fails the plugin, not the process. Providers are not wired this way: `connect` and `models` resolve any registered provider through `providers/catalog`, so `tack connect chatgpt` and `tack models chatgpt` work because the ChatGPT plugin calls `ctx.registerProvider` — never `ctx.registerCli`.

### Plugins

A plugin is a folder with a `plugin.ts` default-exporting the contract in `src/plugins/types.ts`; its `register(ctx)` introduces contributions through the per-module registries. Built-ins (`src/plugins/builtins.ts`) register first, then external plugins from `~/.tack/config.json` in order; later plugins can extend or replace anything. A failing plugin is skipped and reported, never fatal.

```mermaid
sequenceDiagram
    actor User
    participant Entry as index.ts (single entry)
    participant Discover as plugins/discover
    participant P as each Plugin (builtins first, then config order)
    participant Reg as per-module registries

    User->>Entry: tack [command]
    Entry->>Entry: loadSettings()
    Entry->>Discover: registerPlugins(settings)
    loop builtinPlugins, then settings.plugins
        Discover->>P: import <root>/plugin.ts, validate contract
        Discover->>P: plugin.register(ctx)
        P->>Reg: ctx.registerTool / registerProvider / registerCli / registerUi / ...
    end
    alt args given
        Entry->>Reg: runCli(args, ctx) → resolveCli → cli.run(rest, ctx)
    else no args
        Entry->>Reg: getUi(settings.ui ?? "tui").start()
    end
```

### Principles

- Customizable and Extensible by supporting plugins
- Plugins must not rely on eachother. This will make a circular dependencies and this is a hard violation.

## Conventions

- Early returns over nested conditions.
- Typed wire boundaries; narrow `unknown` with `lib/json` guards, never `as` casts.
- Typed unions at seams; handle every case so a new one cannot slip through silently.
- No code comments.
- No backward compatibility. only clean solutions.
- No tests.
- Write simple and readable code and avoid extra complexity.
- If a constant will be used only one time, Do not overengineer to make it `const`. this reduces the code readability.
- Do not write what already exists; reuse it or extract it to one shared place.
- Do not patch symptoms. Fix the root cause.
- Fail loudly. Never swallow an error, and never write data after ignoring one.
- Whatever you write, you must read back in the same shape.
- Build on guarantees, not coincidences.
- Everything must have a consumer today; delete what nothing uses.
- Update docs in the same change that changes the behavior.
- Leave every file you touch consistent with the rules and its neighbors.

## Linting & Formatting

Use `bun checks:fix` to fix any formatting or linting if you modified files that are subject to this.
