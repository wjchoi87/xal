# Tack

A small, customizable terminal coding harness built around a headless agent core and plugins.

To install dependencies:

```bash
bun install
```

To run:

```bash
bun dev
```

## Context compaction

When a session approaches the model's context window, Tack summarizes the older part of the conversation and keeps the most recent turns verbatim. Compaction runs automatically before a model request once the conversation occupies 85% of the window, and on demand with `/compact`; pass instructions to steer it, as in `/compact focus on the migration`.

The summary and its retained tail are written to the session file as one checkpoint, so resuming continues from the compacted state. The full transcript stays in the file and in the terminal — only what the model sees is replaced. Press `ctrl+o` to read the summary.

Automatic compaction keeps a generous tail, since it only needs to get back under the limit. `/compact` keeps a much smaller one, because asking for it means you want the context freed now.

### Context windows on the ChatGPT backend

The ChatGPT subscription backend serves a smaller context window than the published figure for the same model, so `openai-chatgpt` caps every model it reports at 260,000 tokens; models published below that keep their own smaller window. Override the cap when the plan changes:

```json
{
  "pluginConfig": {
    "openai-chatgpt": { "contextWindow": 400000 }
  }
}
```

A model published below the cap keeps its own smaller window; a model Tack has no published figure for — one newer than the metadata, or any model when the metadata is unavailable — is reported at the cap. Setting the cap too low only compacts earlier than necessary; setting it too high lets requests fail at the real limit.

## Tool output

Tool results larger than 2,000 lines or 50 KiB are represented by a head-and-tail preview. Tack saves the complete result in the current session directory and includes its absolute path in the preview. Saved output remains available for as long as the session does.
