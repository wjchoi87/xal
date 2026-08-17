# Providers and models

Connect a built-in or plugin-provided model service, select a model, and configure provider-specific behavior.

## Built-in providers

Built-in provider IDs are `openai`, `openai-chatgpt`, `github-copilot`, `xai`, `deepseek`, and `alibaba-cloud`. `chatgpt` is an alias for `openai-chatgpt`, `copilot` is an alias for `github-copilot`, `grok` is an alias for `xai`, and `dashscope` is an alias for `alibaba-cloud`.

The only built-in UI ID is `tui`. Plugins may register more providers, aliases, and UIs. Anthropic support is available through the external [xal-anthropic](https://github.com/saeedvaziry/xal-anthropic) plugin.

Each provider connection is stored as a named profile. Profile names are globally unique and case-insensitive, while an internal immutable ID keeps sessions, background workers, token refreshes, and caches bound to the same account after a rename.

- Run `/connect`, or `xal connect <provider> [profile]`, to authenticate and name a new profile. A successful connection becomes the default for new sessions.
- Run `/profiles` to rename a profile. The CLI equivalents are `xal profiles` and `xal profiles rename <name> <new-name>`.
- Run `/logout`, or `xal logout [profile]`, to select and remove one connection without affecting other profiles for that provider.
- Run `/model` to choose from the cached model catalogs. Run `/model refresh` or `xal models [provider]` to refresh account-visible models first. Every model belongs to one profile, so choosing a model also chooses the profile and credentials the turn uses. Every model choice shows both its provider and profile name.

The profile behind the selected model is stored as `profile` alongside `provider` and `model` in [Configuration](/docs/configs). For a one-off headless run, use `xal run --connection <profile>`. If `--provider` identifies a provider with multiple profiles and no selected profile resolves the ambiguity, Xal requires `--connection`.

## Model discovery

The active profile's catalog is loaded into the process cache when a session starts. `/model` reuses that cache and requests each other connected profile's non-refresh catalog at most once, so reopening the picker does not reload successful or failed catalogs. A provider may perform initial live discovery when it has no persistent or bundled catalog. `/model refresh` and `xal models` explicitly refresh every connected profile. A provider that fails or returns an invalid catalog is reported without hiding models from the other providers or preventing the session from starting. If a refresh fails after that profile supplied a valid catalog, Xal keeps the previous in-process catalog available. Catalogs supply the model picker, context-window tracking, input modalities, and the choices shown by `/thinking`.

The OpenAI provider discovers models from the API key's `/models` endpoint, keeps GPT-4o and later, o-series, and Codex models that use the Responses API, and stores the last successful result in `<app-home>/cache/openai-models-<profile-id>.json`. The endpoint does not report context windows, input modalities, or reasoning controls, so Xal applies the configured context cap, lowers it for families with smaller documented windows, and marks the discovered agent models as image-capable. It layers model-family reasoning controls over the result, including the full `none` through `max` range for GPT-5.6 and the narrower ranges accepted by earlier GPT-5 models. If live discovery is unavailable, Xal uses that profile's cache or fails when no cache exists.

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

## OpenAI

The `openai` plugin registers both OpenAI providers: `openai` for OpenAI Platform API keys and `openai-chatgpt` for ChatGPT subscriptions. They authenticate and bill separately, but stream over the same OpenAI Responses API and share options under `pluginConfig.openai`:

| Option          | Type             | Default        | Description                                                                  |
| --------------- | ---------------- | -------------- | ---------------------------------------------------------------------------- |
| `contextWindow` | Positive integer | `260000`       | Context-window cap for ChatGPT and assumed context window for OpenAI models. |
| `clientName`    | string           | `codex_cli_rs` | Client name used in both providers' request user agent.                      |

### OpenAI API

Run `xal connect openai`, name the profile, and paste an API key created in the OpenAI Platform. Xal validates the key against `https://api.openai.com/v1/models` before storing it. Requests stream through `https://api.openai.com/v1/responses` with response storage disabled. API profiles are independent from ChatGPT subscription profiles and use the `openai` provider ID in configuration, thinking preferences, and replay data.

### OpenAI ChatGPT

Run `xal connect chatgpt` and choose browser login, pasted callback, or headless device login for a ChatGPT Pro or Plus subscription. ChatGPT subscription requests use the authenticated Codex service and remain separate from OpenAI API billing and API keys.

## DeepSeek

`pluginConfig.deepseek.clientName` is a non-empty string used in the provider request user agent. It defaults to the package application name. DeepSeek currently has no other configuration options.
