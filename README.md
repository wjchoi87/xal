# Xal (Zāl)

A terminal coding harness with a headless agent core where every capability, is a plugin

Powered by [OpenTUI](https://github.com/anomalyco/opentui)

## Development

```bash
bun install
bun dev
```

## Install

Install the latest stable release on macOS, Linux, or Windows from a POSIX shell:

```bash
curl -fsSL https://xal.sh/install | sh
```

Install the beta channel instead:

```bash
curl -fsSL https://xal.sh/install | sh -s -- --beta
```

The installer supports x64 and arm64, including glibc and musl Linux. On Windows, run it from Git Bash, MSYS2, or Cygwin. It installs to `~/.local/bin` by default.

Update within the installed channel:

```bash
xal update
```

Use `xal update --beta` or `xal update --stable` to switch channels. See the [installation and release guide](docs/install.md) for custom paths and the release process.

## Install Locally

```bash
bun install
bun release:local
```

## Run with Profiler

Run with `--profile` to store anonymous session diagnostics and print the profile path when the app exits.
