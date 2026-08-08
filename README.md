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

## Tool output

Tool results larger than 2,000 lines or 50 KiB are represented by a head-and-tail preview. Tack saves the complete result in the current session directory and includes its absolute path in the preview. Saved output remains available for as long as the session does.
