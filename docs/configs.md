# Configuration

Tack reads JSON configuration from two locations:

| Layer   | Path                                                                         | Priority |
| ------- | ---------------------------------------------------------------------------- | -------- |
| User    | `$TACK_HOME/config.json`, or `~/.tack/config.json` when `TACK_HOME` is unset | Lower    |
| Project | `<git-root>/.tack/config.json`                                               | Higher   |

Tack searches upward from the working directory for `.git`. When no Git root is found, the working directory is used as the project root.

Both files are optional and must contain a JSON object when present. Objects merge recursively from user to project configuration. Arrays and scalar values are replaced by the project value. Project configuration currently applies to every option, including plugins and permission rules, so it must be treated as trusted code and policy.

Commands that save model or thinking preferences write the user file. The effective configuration is then recomputed, and any project override remains active.

## Options

| Option         | Type       | Default                  | Description                                                                             |
| -------------- | ---------- | ------------------------ | --------------------------------------------------------------------------------------- |
| `plugins`      | `string[]` | `[]`                     | Additional plugins loaded after built-in plugins.                                       |
| `provider`     | `string`   | Last registered provider | Provider ID or alias used for new sessions.                                             |
| `model`        | `string`   | Provider default         | Model ID used for new sessions. Run `tack models` to refresh and list available models. |
| `ui`           | `string`   | `"tui"`                  | UI ID started when Tack is run without a command.                                       |
| `pluginConfig` | `object`   | `{}`                     | Configuration keyed by plugin name.                                                     |
| `thinking`     | `object`   | `{}`                     | Thinking effort keyed by provider ID and then model ID.                                 |

Built-in provider IDs are `openai-chatgpt` and `deepseek`. `chatgpt` is an alias for `openai-chatgpt`. The only built-in UI ID is `tui`. Plugins may register more providers, aliases, and UIs.

### Plugins

The `plugins` array tells Tack what to load; it does not install or download anything. Every referenced plugin must already exist and be resolvable when Tack starts. If importing or validating a plugin fails, Tack records a plugin registration failure and does not use that plugin.

Each `plugins` entry supports one of these forms:

- An already-installed package or module specifier, passed directly to Bun's module loader.
- A relative directory beginning with `.`, resolved from the Tack home directory and expected to contain `plugin.ts`.
- An absolute directory expected to contain `plugin.ts`.

For example, this loads an existing local plugin:

```json
{
  "plugins": ["/absolute/path/to/my-plugin"]
}
```

The referenced directory must contain a `plugin.ts` whose default export has a `name`, a synchronous `register` function, and optionally asynchronous `bootstrap` and `shutdown` functions. Relative plugin paths are not resolved from the project directory, even when they are declared in project configuration.

Plugins can contribute slash commands with `ctx.registerCommand`. Commands known synchronously belong in `register`; commands discovered from files or services may be added during `bootstrap`, before interactive input is released.

When the UI or CLI exits, Tack aborts `ctx.signal` so in-progress `bootstrap` work can stop, waits for bootstrap to settle, and then runs `shutdown` in reverse plugin order. Plugins that own child processes or network connections close them there. A dynamically discovered tool can be removed with `ctx.unregisterTool(tool)` using the same tool object that was registered.

### Hooks

Plugins register trusted in-process lifecycle hooks with `ctx.registerHook`. Hooks run in built-in/plugin configuration order, and multiple hooks for the same event run sequentially. A replacement from one hook becomes the input to the next hook.

| Handler      | Input                                       | Allowed result                                              |
| ------------ | ------------------------------------------- | ----------------------------------------------------------- |
| `prompt`     | Model-facing prompt text and image count    | Replace the text or reject the prompt                       |
| `beforeTool` | Tool name, call ID, and JSON arguments      | Replace the arguments or block the call                     |
| `afterTool`  | Tool details and its model-facing output    | Replace the output                                          |
| `turnEnd`    | Final output and token usage when available | No result; use it for lifecycle automation or observability |

Every handler also receives a context containing an abort signal and the session ID, kind, working directory, provider, model, and permission mode. Prompt changes affect what the model sees while the TUI keeps the user's original text. Tool argument changes happen before scheduling and permission evaluation, so Tack authorizes and records the effective action. Post-tool hooks also run for failed or interrupted tool executions, but not for calls blocked before execution.

Hook failures stop prompt, pre-tool, and turn-completion processing. A post-tool failure becomes a failed tool result that warns the model the tool may already have changed state. Hook inputs and code run inside Tack's process, so only load hooks you trust. Returned text and arguments pass through secret redaction before they reach the model, session storage, or TUI.

This plugin marks prompts and read results, and blocks an exact `git push` command:

```ts
export default {
  name: "visual-hooks",
  register(ctx) {
    ctx.registerHook({
      name: "marker",
      prompt(input) {
        return { type: "replace", text: `${input.text}\n\nInclude the exact marker HOOKS_ACTIVE in the answer.` }
      },
      beforeTool(input) {
        if (input.tool !== "bash" || input.args.command !== "git push") return
        return { type: "block", reason: "Publishing is disabled by the visual hook." }
      },
      afterTool(input) {
        if (input.tool !== "read") return
        return { type: "replace", output: `[visual-hooks]\n${input.output}` }
      },
    })
  },
}
```

Put the file at `plugin.ts` inside a plugin directory and add that directory's absolute path to `plugins`. In the TUI, `/hooks` lists every registered hook and the events it handles. Each completed primary-session hook invocation appears in the transcript with its action and elapsed time; sub-agent hook invocations appear in that agent's job output.

### Thinking

Thinking preferences use this shape:

```json
{
  "thinking": {
    "openai-chatgpt": {
      "gpt-5.6-terra": "high"
    },
    "deepseek": {
      "deepseek-v4-flash": "max"
    }
  }
}
```

Supported effort values are `none`, `low`, `medium`, `high`, `xhigh`, and `max`. Each provider and model may support only a subset. An unavailable saved effort is ignored in favor of that model's default.

### Model discovery

`tack models` and the TUI's `/model` command refresh every connected provider's model catalog. The catalog supplies the model picker, context-window tracking, input modalities, and the choices shown by `/thinking`.

The ChatGPT provider discovers the account-visible catalog from the authenticated Codex service and stores the last successful result in `$TACK_HOME/cache/openai-chatgpt-models.json` (or `~/.tack/cache/openai-chatgpt-models.json`). If live discovery is unavailable, Tack reports the failure and uses that cache, then its bundled catalog. DeepSeek discovers models from its authenticated `/models` endpoint and reports when it must use bundled model metadata.

## Prompt commands

Tack discovers reusable Markdown prompt commands from two directories:

| Scope   | Path                             | Priority |
| ------- | -------------------------------- | -------- |
| User    | `$TACK_HOME/commands/*.md`       | Lower    |
| Project | `<git-root>/.tack/commands/*.md` | Higher   |

When `TACK_HOME` is unset, the user directory is `~/.tack/commands`. A project command replaces a user command with the same filename. Command filenames become slash-command names and must use lower-case letters, numbers, hyphens, or underscores. Prompt commands cannot replace built-in or plugin-registered commands.

Each file contains the prompt sent to the active session. Optional frontmatter supplies its command-palette description and argument hint:

```md
---
description: Review the current changes
argument-hint: <base-branch> [focus]
---

Review the current changes against $1. Pay particular attention to $2.

Additional context: $ARGUMENTS
```

`$1`, `$2`, and later numbered placeholders expand to positional arguments. `$ARGUMENTS` expands to all arguments joined with spaces, and `$$` emits a literal dollar sign. Missing positional arguments expand to an empty string.

After startup, type `/` in the TUI to see discovered commands in the command palette. Selecting one submits the expanded prompt through the same session path as a typed message.

## Skills

Tack discovers reusable skill packages from four directories, in increasing priority:

| Scope   | Path                                    |
| ------- | --------------------------------------- |
| User    | `~/.agents/skills/**/SKILL.md`          |
| User    | `$TACK_HOME/skills/**/SKILL.md`         |
| Project | `<git-root>/.agents/skills/**/SKILL.md` |
| Project | `<git-root>/.tack/skills/**/SKILL.md`   |

When `TACK_HOME` is unset, its user skill directory is `~/.tack/skills`. A later package replaces an earlier package with the same skill name. Project skill directories are read only after workspace trust is established.

Every package is a directory named after its skill and containing a `SKILL.md` entry file. The entry file requires YAML frontmatter with a lower-case, hyphen-separated `name` and a `description`, followed by non-empty instructions:

```md
---
name: review-changes
description: Review the current workspace changes for correctness
---

Inspect the current diff, validate every finding, and report only actionable issues.
```

Only skill names and descriptions enter the system prompt. The model loads full instructions on demand with the read-only `skill` tool, which can also read referenced text files inside that package without allowing paths to escape the package directory. `SKILL.md` files are limited to 64 KiB and supporting files read through the tool are limited to 50,000 bytes.

Type `$` anywhere in the TUI composer to open skill completion. Continue typing to filter, then press Tab, Right, or Enter to replace only the skill reference at the cursor. Known `$skill-name` references are highlighted both while editing and in the submitted user message.

A prompt beginning with `$skill-name` explicitly invokes that skill. Tack keeps the compact original prompt visible in the conversation while sending the full skill instructions and the remaining user input to the model. A `$skill-name` reference later in a prompt remains ordinary user text, matching the behavior of other inline references. Skills do not register slash commands or appear in `/` completion.

## Built-in plugin configuration

### `mcp`

MCP servers are configured under `pluginConfig.mcp.servers`. Server names must begin with a lower-case letter and contain only lower-case letters, numbers, hyphens, and underscores.

```json
{
  "pluginConfig": {
    "mcp": {
      "servers": {
        "local-tools": {
          "transport": "stdio",
          "command": "node",
          "args": ["/absolute/path/to/server.js"],
          "cwd": "/absolute/path/to/project",
          "env": {
            "SERVICE_TOKEN": "${SERVICE_TOKEN}"
          },
          "timeoutMs": 30000
        },
        "remote-tools": {
          "transport": "http",
          "url": "https://example.com/mcp",
          "headers": {
            "Authorization": "Bearer ${MCP_TOKEN}"
          }
        }
      }
    }
  }
}
```

Each server supports `enabled` (default `true`) and `timeoutMs` (default `30000`). A stdio server requires `command`, accepts optional `args`, `cwd`, and `env`, and inherits the SDK's safe default process environment. Relative `cwd` values resolve from the directory where Tack starts. An HTTP server requires `url` and accepts optional `headers`; Tack tries Streamable HTTP first and falls back to legacy SSE at the same URL only when the initial Streamable HTTP request receives a 4xx response.

If a higher-priority configuration changes an existing server's transport, fields inherited for the inactive transport are ignored. Unknown field names still fail configuration.

`${NAME}` references in commands, arguments, working directories, environment values, URLs, and headers expand from Tack's environment. A missing variable makes the MCP configuration fail instead of starting with an incomplete value. Values in secret-like environment variables and headers are added to Tack's redaction set.

Servers connect in parallel during plugin bootstrap. One unavailable server is reported as failed without hiding tools from healthy servers. Discovered tools use names such as `mcp__local-tools__count`, retain their remote input schemas, and pass through normal permission handling. Every remote MCP call is treated as an unsandboxed mutation and invalidates workspace redo history because server annotations are untrusted hints and the tool's effects are external or unknown. Reading a remote resource or resolving a remote prompt also requires approval; listing their already-cached catalogs remains read-only.

Connected resource catalogs, resource templates, and prompts are exposed through `mcp_resources`, `mcp_read_resource`, `mcp_prompts`, and `mcp_get_prompt`. Server instructions join the system prompt. Binary resource and image or audio content is summarized with its media type and byte size because Tack's tool-result boundary is text-only. Tools that require the experimental MCP task protocol, or whose output schema uses an unsupported dialect, are skipped and reported in status; ordinary and task-optional tools remain available. Tool-list change notifications refresh registered tools, and `/mcp reconnect [server]` reconnects one server or all servers. Run `/mcp` to see transport, status, and capability counts.

### `permissions`

```json
{
  "pluginConfig": {
    "permissions": {
      "allow": ["bash(git status*)"],
      "ask": ["bash(git push*)"],
      "deny": ["bash(rm *)"]
    }
  }
}
```

`allow`, `ask`, and `deny` are arrays of permission rules. A rule is either a tool name, such as `bash`, or a tool and subject pattern, such as `bash(git status*)` or `write(src/*)`. `*` matches any sequence of characters. Deny rules are evaluated before all other permission rules.

### `redaction`

| Option        | Type       | Default | Description                                                     |
| ------------- | ---------- | ------- | --------------------------------------------------------------- |
| `values`      | `string[]` | `[]`    | Exact sensitive values to replace.                              |
| `environment` | `string[]` | `[]`    | Environment variable names whose current values should be used. |

Matches are case-sensitive and normally become `[REDACTED]` before content reaches a model, session or prompt-history storage, tool-output artifacts, CLI output, or the TUI. Tack chooses a safe alternate marker when a configured value is part of that text. Provider access tokens, refresh tokens, and API keys in Tack's credential store are included automatically. Prefer `environment` for additional values so the secret itself does not need to appear in a configuration file.

Custom plugins can add values from their own credential sources with `ctx.registerSecrets`.

### `project-instructions`

| Option     | Type             | Default | Description                                                          |
| ---------- | ---------------- | ------- | -------------------------------------------------------------------- |
| `maxBytes` | Positive integer | `32768` | Maximum combined UTF-8 byte budget for discovered `AGENTS.md` files. |

### `openai-chatgpt`

| Option          | Type             | Default  | Description                                                 |
| --------------- | ---------------- | -------- | ----------------------------------------------------------- |
| `contextWindow` | Positive integer | `260000` | Upper bound applied to the model's reported context window. |

Other built-in plugins currently have no configuration options. A custom plugin receives the object under `pluginConfig` whose key matches its exported plugin name.

## Complete example

Every option is optional. A configuration using all currently supported built-in options looks like this:

```json
{
  "plugins": ["/absolute/path/to/example-plugin"],
  "provider": "openai-chatgpt",
  "model": "gpt-5.6-terra",
  "ui": "tui",
  "thinking": {
    "openai-chatgpt": {
      "gpt-5.6-terra": "high"
    }
  },
  "pluginConfig": {
    "permissions": {
      "allow": ["bash(git status*)"],
      "ask": ["bash(git push*)"],
      "deny": ["bash(rm *)"]
    },
    "redaction": {
      "environment": ["MY_PROJECT_TOKEN"]
    },
    "project-instructions": {
      "maxBytes": 65536
    },
    "mcp": {
      "servers": {
        "local-tools": {
          "transport": "stdio",
          "command": "node",
          "args": ["/absolute/path/to/server.js"]
        }
      }
    },
    "openai-chatgpt": {
      "contextWindow": 260000
    },
    "example-plugin": {
      "enabled": true
    }
  }
}
```
