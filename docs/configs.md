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

The referenced directory must contain a `plugin.ts` whose default export has a `name`, a synchronous `register` function, and optionally an asynchronous `bootstrap` function. Relative plugin paths are not resolved from the project directory, even when they are declared in project configuration.

Plugins can contribute slash commands with `ctx.registerCommand`. Commands known synchronously belong in `register`; commands discovered from files or services may be added during `bootstrap`, before interactive input is released.

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
    "openai-chatgpt": {
      "contextWindow": 260000
    },
    "example-plugin": {
      "enabled": true
    }
  }
}
```
