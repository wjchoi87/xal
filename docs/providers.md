# Providers and models

Connect a built-in or plugin-provided model service, select a model, and configure provider-specific behavior.

## Built-in providers

Built-in provider IDs are `openai-chatgpt`, `github-copilot`, `xai`, `deepseek`, and `alibaba-cloud`. `chatgpt` is an alias for `openai-chatgpt`, `copilot` is an alias for `github-copilot`, `grok` is an alias for `xai`, and `dashscope` is an alias for `alibaba-cloud`.

The only built-in UI ID is `tui`. Plugins may register more providers, aliases, and UIs. Anthropic support is available through the external [xal-anthropic](https://github.com/saeedvaziry/xal-anthropic) plugin.

Each provider connection is stored as a named profile. Profile names are globally unique and case-insensitive, while an internal immutable ID keeps sessions, background workers, token refreshes, and caches bound to the same account after a rename.

- Run `/connect`, or `xal connect <provider> [profile]`, to authenticate and name a new profile. A successful connection becomes the default for new sessions.
- Run `/profiles` to rename a profile. The CLI equivalents are `xal profiles` and `xal profiles rename <name> <new-name>`.
- Run `/logout`, or `xal logout [profile]`, to select and remove one connection without affecting other profiles for that provider.
- Run `/model` or `xal models [provider]` to refresh account-visible models. Every model belongs to one profile, so choosing a model also chooses the profile and credentials the turn uses. Every model choice shows both its provider and profile name.

The profile behind the selected model is stored as `profile` alongside `provider` and `model` in [Configuration](/docs/configs). For a one-off headless run, use `xal run --connection <profile>`. If `--provider` identifies a provider with multiple profiles and no selected profile resolves the ambiguity, Xal requires `--connection`.

## Model discovery

`xal models` and `/model` refresh every connected profile's model catalog. The catalog supplies the model picker, context-window tracking, input modalities, and the choices shown by `/thinking`.

The ChatGPT provider discovers the account-visible catalog from the authenticated Codex service and stores the last successful result in `<app-home>/cache/openai-chatgpt-models-<profile-id>.json`. If live discovery is unavailable, Xal reports the failure and uses that profile's cache, then its bundled catalog.

GitHub Copilot discovers the models enabled for each connected subscription and stores the compatible subset in `<app-home>/cache/github-copilot-models-<profile-id>.json`, bound to the token and GitHub domain that produced it. It exposes tool-capable models that advertise `/chat/completions` or omit endpoint metadata. Models that explicitly advertise only Responses or Anthropic Messages remain hidden. Some Personal Copilot accounts leave every model-picker flag unset, so the canonical Personal endpoint falls back to explicitly policy-enabled compatible models. Enterprise endpoints keep strict picker visibility. If live discovery is unavailable, only that profile's matching validated cache is used; without one, model discovery fails.

xAI discovers models from its authenticated `/models` endpoint, hides the image, speech, and voice models that the chat endpoint rejects, and layers bundled context windows and thinking options over the result because that endpoint reports neither. The account's credential decides what the endpoint returns, so a Grok subscription and an API key each see their own catalog. DeepSeek discovers models from its authenticated `/models` endpoint and reports when it must use bundled model metadata. Alibaba Cloud uses a bundled catalog of Qwen models shared by Model Studio and Coding Plan.

## Alibaba Cloud

Configure options under `pluginConfig.alibaba-cloud`:

| Option       | Type   | Default                                                  | Description                                                                           |
| ------------ | ------ | -------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `baseUrl`    | string | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` | HTTPS OpenAI-compatible endpoint for the API key's region, workspace, or Coding Plan. |
| `clientName` | string | Package application name                                 | Client name used in the provider request user agent.                                  |

Alibaba Cloud Model Studio API keys are region-specific. Set `baseUrl` to the OpenAI-compatible API Host shown when the key is created. Coding Plan keys use `https://coding-intl.dashscope.aliyuncs.com/v1`. `/connect` stores the key without making a billable model request; the first turn validates that the key, endpoint, and selected model are compatible.

## GitHub Copilot

Configure options under `pluginConfig.github-copilot`:

| Option             | Type   | Default                  | Description                                                  |
| ------------------ | ------ | ------------------------ | ------------------------------------------------------------ |
| `enterpriseDomain` | string | `github.com`             | GitHub Enterprise domain or HTTPS URL used for device login. |
| `clientName`       | string | Package application name | Client name used in the provider request user agent.         |

Run `xal connect copilot`, open the displayed GitHub device-login URL, and enter its one-time code. Xal uses the resulting GitHub OAuth token directly with the Copilot API and validates that the account returns at least one compatible agent model before storing the token. Personal catalogs that omit endpoint, picker, or policy metadata are accepted unless a model is explicitly incompatible or disabled. For GitHub Enterprise, configure `enterpriseDomain` before connecting.

## xAI

Configure options under `pluginConfig.xai`:

| Option       | Type   | Default                  | Description                                                        |
| ------------ | ------ | ------------------------ | ------------------------------------------------------------------ |
| `baseUrl`    | string | `https://api.x.ai/v1`    | HTTPS OpenAI-compatible endpoint used for inference and discovery. |
| `clientName` | string | Package application name | Client name used in the provider request user agent.               |

Run `xal connect xai` and choose how to authenticate:

- **SuperGrok or X Premium subscription.** Xal starts an OAuth device authorization at `auth.x.ai`, prints a verification URL and a one-time code, and polls until you approve it. Nothing listens on a local port, so this works over SSH, in containers, and on machines with no browser. Access tokens refresh automatically five minutes before they expire, and a refresh that xAI does not rotate keeps the existing refresh token.
- **xAI API key.** Paste a key created at `console.x.ai`. Xal validates it against the models endpoint before storing it.

Both credential types stream over the OpenAI Responses API, where Grok models expose `low`, `medium`, `high`, and `xhigh` thinking effort. `max` maps to `xhigh`, the highest level xAI accepts. The model catalog is the single source of truth for that dial, so `/thinking` and the wire never disagree. A few Grok reasoners — the `grok-build` and `grok-4.20-0309` families and `grok-composer` — think natively but reject the effort parameter, so `/thinking` does not offer it for them and no effort is sent.

## OpenAI ChatGPT

Configure options under `pluginConfig.openai-chatgpt`:

| Option          | Type             | Default                  | Description                                                 |
| --------------- | ---------------- | ------------------------ | ----------------------------------------------------------- |
| `contextWindow` | Positive integer | `260000`                 | Upper bound applied to the model's reported context window. |
| `clientName`    | string           | Package application name | Client name used in the provider request user agent.        |

## DeepSeek

`pluginConfig.deepseek.clientName` is a non-empty string used in the provider request user agent. It defaults to the package application name. DeepSeek currently has no other configuration options.
