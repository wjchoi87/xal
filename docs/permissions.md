# Permissions and security

Control which tools can run, define permission modes, and prevent sensitive values from reaching models or stored output.

## Permission rules

```json
{
  "permissions": {
    "allow": ["bash(git status*)"],
    "ask": ["bash(git push*)"],
    "deny": ["bash(rm -rf /*)"]
  }
}
```

`allow`, `ask`, and `deny` are arrays of permission rules. A rule is either a tool name, such as `bash`, or a tool and subject pattern, such as `bash(git status*)` or `write(src/*)`. `*` matches any sequence of characters and also works in the tool name, so `mcp__github__*` matches every tool from that MCP server and `*` alone matches every tool. Deny rules are evaluated before all other permission rules.

Chained commands are evaluated per segment, so `git status && rm /etc/hosts` asks even though `git status` alone would not. Commands using substitution or grouping that cannot be split safely always ask. Built-in risky-command rules are ordinary rules, so configuration can override them. For example, `"allow": ["bash(curl *)"]` stops `curl` from asking.

## Built-in modes

Xal ships three modes, cycled while the session is idle with the `session.next-mode` shortcut, Shift+Tab by default:

- `normal` is the default. Actions run without confirmation unless they are risky: shell commands whose file arguments, redirect targets, or `cd` destinations leave the workspace; destructive commands aimed at the workspace root or `.git`; file writes and edits outside the workspace; privileged or system-level commands such as `sudo` and `dd`; network fetches with `curl` or `wget`; force pushes; package publishes; and reads of `.env` files or key material. MCP calls run without confirmation unless an explicit permission rule asks or denies them. Deletes and other file operations inside the workspace run without prompting because workspace undo can restore them. Writes to the system temporary directory are also allowed.
- `plan` is read-only. Tools that mutate anything are refused before they run.
- `yolo` converts every ask into an allow. Deny rules still block actions.

## Plan mode

`/plan [prompt]` enters plan mode and can submit the planning request in the same command. The agent grounds repository facts with read-only tools, asks structured questions only for material choices that cannot be discovered, and produces a self-contained implementation plan. `submit_plan` saves the complete Markdown as the session-local `plan.md`, renders it for review, and offers approval or revision. Free-form review input becomes revision feedback, and each resubmission replaces the complete proposal.

Approval restores the writable permission mode that was active before planning and begins implementation with the approved plan in context. If the prior mode was read-only, approval uses `normal`. A dismissed review leaves plan mode active and waits for new direction. User-driven mode changes are refused while a turn, approval, or input request is active so one turn cannot silently cross permission boundaries.

## Custom modes

Custom modes are defined under `modes` and appear in the TUI mode cycle and `--mode`:

```json
{
  "modes": {
    "paranoid": { "ask": ["*"], "guidance": "Every action needs confirmation." },
    "trusting": { "base": "normal", "allow": ["bash(curl *)", "write(/*)"] }
  }
}
```

`base` selects the built-in mode a custom mode behaves like. It defaults to `normal`; `plan` inherits read-only behavior and `yolo` inherits ask-skipping. `allow`, `ask`, and `deny` are mode-scoped rules that apply only while the mode is active. They sit above global `permissions` rules and below approvals remembered from the approval prompt. `guidance` replaces the mode instructions shown to the model.

Built-in mode names cannot be redefined. A session restored with a mode that no longer exists falls back to `normal`.

## Redaction

| Option        | Type       | Default | Description                                                     |
| ------------- | ---------- | ------- | --------------------------------------------------------------- |
| `values`      | `string[]` | `[]`    | Exact sensitive values to replace.                              |
| `environment` | `string[]` | `[]`    | Environment variable names whose current values should be used. |

```json
{
  "redaction": {
    "environment": ["MY_PROJECT_TOKEN"],
    "values": ["sensitive-literal"]
  }
}
```

Matches are case-sensitive and normally become `[REDACTED]` before content reaches a model, session or prompt-history storage, tool-output artifacts, CLI output, or the TUI. Xal chooses a safe alternate marker when a configured value is part of that text. Provider access tokens, refresh tokens, and API keys in the credential store are included automatically. Prefer `environment` for additional values so the secret itself does not need to appear in a configuration file.

Custom plugins can add values from their own credential sources with `ctx.registerSecrets`.
