# Installation and releases

## Install

The installer downloads one native executable, verifies its SHA-256 checksum, and places it in `~/.local/bin`.

```bash
curl -fsSL https://xal.sh/install | sh
```

This command installs the latest stable release. The supported targets are:

| Operating system | Architectures | Variants      |
| ---------------- | ------------- | ------------- |
| macOS            | x64, arm64    | Native        |
| Linux            | x64, arm64    | glibc, musl   |
| Windows          | x64, arm64    | Native `.exe` |

Windows installation requires a POSIX shell such as Git Bash, MSYS2, or Cygwin. Running the command in WSL installs the Linux build inside WSL.

Set `XAL_INSTALL_DIR` on the shell that runs the installer to choose another destination:

```bash
curl -fsSL https://xal.sh/install | XAL_INSTALL_DIR="$HOME/bin" sh
```

The destination must be on `PATH` before `xal` can be invoked by name.

## Channels

Stable is the default channel. Install the newest beta with:

```bash
curl -fsSL https://xal.sh/install | sh -s -- --beta
```

`xal update` preserves the channel encoded in the installed version:

```bash
xal update
xal update --beta
xal update --stable
```

A beta version has the form `X.Y.Z-beta.N`. Stable versions use `X.Y.Z`.

## Beta releases

Every push to `main` runs `.github/workflows/release-beta.yml`. The workflow runs all repository checks, derives the beta version from `apps/cli/package.json` and the commit count, and builds every supported target.

Each successful run publishes:

- A versioned GitHub prerelease tagged `vX.Y.Z-beta.N` whose assets are never overwritten by the workflow.
- A rolling `version.txt` pointer under the `beta` release tag.
- `version.txt` and `SHA256SUMS` metadata used by the installer and updater.

The installer and updater resolve the rolling pointer first, then download the executable and checksums from the complete versioned prerelease.

Change the version in `apps/cli/package.json` on `main` when beta development should begin for a new stable version.

## Stable releases

Run the **Release stable** workflow manually with:

- `beta_tag`: the published beta to promote, such as `v0.0.1-beta.42`.
- `version`: the stable version to publish, such as `0.0.1`.

The workflow verifies that the beta is a published prerelease reachable from `main` and that its base version matches the requested stable version. It checks out the beta's resolved commit, rebuilds every target with the stable version embedded, and publishes `vX.Y.Z` as the latest stable GitHub release. Existing stable tags cannot be overwritten.

## Installer deployment

`.github/workflows/website.yml` deploys website and documentation changes to Cloudflare, including the installer served at `https://xal.sh/install`. Configure these repository secrets before enabling the workflow:

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`
