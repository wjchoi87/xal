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
