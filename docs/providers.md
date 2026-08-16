# Providers and models

Connect a built-in or plugin-provided model service, select a model, and configure provider-specific behavior.

## Built-in providers

Built-in provider IDs are `openai-chatgpt`, `github-copilot`, `deepseek`, and `alibaba-cloud`. `chatgpt` is an alias for `openai-chatgpt`, `copilot` is an alias for `github-copilot`, and `dashscope` is an alias for `alibaba-cloud`.

The only built-in UI ID is `tui`. Plugins may register more providers, aliases, and UIs. Anthropic support is available through the external [xal-anthropic](https://github.com/saeedvaziry/xal-anthropic) plugin.

Set `provider` and `model` in [Configuration](/docs/configs), or use the corresponding TUI commands. Run `xal models` or `/model` to refresh and list available models.

## Model discovery

`xal models` and `/model` refresh every connected provider's model catalog. The catalog supplies the model picker, context-window tracking, input modalities, and the choices shown by `/thinking`.

The ChatGPT provider discovers the account-visible catalog from the authenticated Codex service and stores the last successful result in `<app-home>/cache/openai-chatgpt-models.json`. If live discovery is unavailable, Xal reports the failure and uses that cache, then its bundled catalog.

GitHub Copilot discovers the models enabled for the connected subscription and stores the compatible subset in `<app-home>/cache/github-copilot-models.json`, bound to the token and GitHub domain that produced it. It exposes tool-capable models that advertise `/chat/completions` or omit endpoint metadata. Models that explicitly advertise only Responses or Anthropic Messages remain hidden. Some Personal Copilot accounts leave every model-picker flag unset, so the canonical Personal endpoint falls back to explicitly policy-enabled compatible models. Enterprise endpoints keep strict picker visibility. If live discovery is unavailable, only a matching validated cache is used; without one, model discovery fails.

DeepSeek discovers models from its authenticated `/models` endpoint and reports when it must use bundled model metadata. Alibaba Cloud uses a bundled catalog of Qwen models shared by Model Studio and Coding Plan.

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

## OpenAI ChatGPT

Configure options under `pluginConfig.openai-chatgpt`:

| Option          | Type             | Default                  | Description                                                 |
| --------------- | ---------------- | ------------------------ | ----------------------------------------------------------- |
| `contextWindow` | Positive integer | `260000`                 | Upper bound applied to the model's reported context window. |
| `clientName`    | string           | Package application name | Client name used in the provider request user agent.        |

## DeepSeek

`pluginConfig.deepseek.clientName` is a non-empty string used in the provider request user agent. It defaults to the package application name. DeepSeek currently has no other configuration options.
