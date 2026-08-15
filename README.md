# Terminal coding harness

A small, customizable terminal coding harness built around a headless agent core and plugins.

## Workspace

This repository is a Bun workspace managed by Turborepo. The terminal application lives in `apps/cli`; additional applications belong under `apps/`.

## Development

```bash
bun install
bun dev
```

## Install Locally

```bash
bun install
bun release:local
```

## Run with Profiler

Run with `--profile` to store anonymous session diagnostics and print the profile path when the app exits.
