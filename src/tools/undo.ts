import { Buffer } from "node:buffer"
import { spawn } from "node:child_process"
import { realpathSync } from "node:fs"
import { lstat, mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { describeError, isMissingPathError } from "../lib/error"

export interface UndoPreview {
  messageId: string
  prompt: string
  paths: string[]
  codeAvailable: boolean
  unavailable?: string
}

interface GitOutput {
  stdout: Buffer
  stderr: Buffer
  exitCode: number
  stdinError?: Error
}

interface GitCommandOptions {
  indexFile?: string
  input?: Uint8Array
}

interface Snapshot {
  before: string
  after: string
  paths: string[]
  index: Buffer
  gitlinks: Gitlink[]
  forced: string[]
}

interface Gitlink {
  path: string
  before: string
  after: string
}

interface TreeEntry {
  mode: string
  object: string
}

interface PromptCheckpoint {
  messageId: string
  prompt: string
  snapshot: number
  available: boolean
  unavailable?: string
}

interface BusyState {
  kind: "capture" | "rewind" | "redo"
  token: symbol
}

interface RewindTransaction {
  snapshots: Snapshot[]
  checkpoints: PromptCheckpoint[]
  snapshotPosition: number
  checkpointPosition: number
  branch: number
  token: symbol
}

interface RedoTransaction {
  snapshots: Snapshot[]
  checkpoints: PromptCheckpoint[]
  snapshotPosition: number
  checkpointPosition: number
  branch: number
}

type RepositoryDiscovery = { status: "ready"; repository: Repository } | { status: "unavailable"; reason: string }

const utf8 = new TextDecoder("utf-8", { fatal: true })

function canonicalPath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

function canonicalTarget(path: string): string {
  let current = resolve(path)
  const suffix: string[] = []
  while (true) {
    try {
      return resolve(realpathSync(current), ...suffix.toReversed())
    } catch {
      const parent = dirname(current)
      if (parent === current) return resolve(path)
      suffix.push(basename(current))
      current = parent
    }
  }
}

function pathIsInside(base: string, target: string): boolean {
  const path = relative(base, target)
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`))
}

function gitPath(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/")
}

function decode(bytes: Uint8Array, message: string): string {
  try {
    return utf8.decode(bytes)
  } catch (error) {
    throw new Error(message, { cause: error })
  }
}

function outputText(output: GitOutput): string {
  return decode(output.stdout, "git returned a non-UTF-8 object ID").trimEnd()
}

function outputPath(output: GitOutput): string {
  let end = output.stdout.length
  if (end > 0 && output.stdout[end - 1] === 10) end--
  if (end > 0 && output.stdout[end - 1] === 13) end--
  return decode(output.stdout.subarray(0, end), "git returned a non-UTF-8 repository path")
}

function nulSeparatedPaths(bytes: Buffer): string[] {
  if (bytes.length === 0) return []
  if (bytes[bytes.length - 1] !== 0) throw new Error("git returned a malformed path list")
  const paths: string[] = []
  let start = 0
  for (let index = 0; index < bytes.length; index++) {
    if (bytes[index] !== 0) continue
    if (index > start) paths.push(decode(bytes.subarray(start, index), "git returned a non-UTF-8 path"))
    start = index + 1
  }
  return paths
}

function commandError(output: GitOutput, args: string[]): string {
  const detail = output.stderr.toString("utf8").trim()
  if (detail) return detail
  return `git ${args[0] ?? "command"} exited with code ${output.exitCode}`
}

function runGit(cwd: string, args: string[], options: GitCommandOptions = {}): Promise<GitOutput> {
  return new Promise((resolveOutput, rejectOutput) => {
    const environment = options.indexFile ? { ...process.env, GIT_INDEX_FILE: options.indexFile } : process.env
    const child = spawn(
      "git",
      [
        "-C",
        cwd,
        "--literal-pathspecs",
        "-c",
        "core.autocrlf=false",
        "-c",
        "core.longpaths=true",
        "-c",
        "core.symlinks=true",
        ...args,
      ],
      { env: environment },
    )
    const stdout: Uint8Array[] = []
    const stderr: Uint8Array[] = []
    let stdinError: Error | undefined
    let settled = false

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk))
    child.stdin.on("error", (error: Error) => {
      stdinError = error
    })
    child.once("error", (error) => {
      if (settled) return
      settled = true
      rejectOutput(new Error(`could not run git: ${error.message}`, { cause: error }))
    })
    child.once("close", (exitCode, signal) => {
      if (settled) return
      settled = true
      if (exitCode === null) {
        rejectOutput(new Error(`git ${args[0] ?? "command"} was terminated${signal ? ` by ${signal}` : ""}`))
        return
      }
      resolveOutput({
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        exitCode,
        ...(stdinError ? { stdinError } : {}),
      })
    })
    child.stdin.end(options.input)
  })
}

async function checkedGit(cwd: string, args: string[], options: GitCommandOptions = {}): Promise<GitOutput> {
  const output = await runGit(cwd, args, options)
  if (output.exitCode !== 0) throw new Error(commandError(output, args))
  if (output.stdinError) {
    throw new Error(`could not send input to git ${args[0] ?? "command"}: ${output.stdinError.message}`, {
      cause: output.stdinError,
    })
  }
  return output
}

async function applyAtomically(
  snapshots: Snapshot[],
  apply: (snapshot: Snapshot) => Promise<void>,
  rollback: (snapshot: Snapshot) => Promise<void>,
  rollbackMessage: string,
): Promise<void> {
  const applied: Snapshot[] = []
  for (const snapshot of snapshots) {
    try {
      await apply(snapshot)
      applied.push(snapshot)
    } catch (error) {
      try {
        for (const completed of applied.toReversed()) await rollback(completed)
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `${describeError(error)}; ${rollbackMessage}: ${describeError(rollbackError)}`,
          { cause: rollbackError },
        )
      }
      throw error
    }
  }
}

class Repository {
  private constructor(
    private readonly workspace: string,
    private readonly top: string,
  ) {}

  static async discover(workspace: string): Promise<RepositoryDiscovery> {
    let output: GitOutput
    try {
      output = await runGit(workspace, ["rev-parse", "--show-toplevel"])
    } catch (error) {
      return { status: "unavailable", reason: describeError(error) }
    }
    if (output.exitCode !== 0) return { status: "unavailable", reason: "the workspace is not a Git repository" }
    if (output.stdinError) {
      return {
        status: "unavailable",
        reason: `could not discover the Git repository: ${output.stdinError.message}`,
      }
    }

    try {
      const top = await realpath(outputPath(output))
      if (!pathIsInside(top, workspace)) {
        return { status: "unavailable", reason: "Git reported a repository outside the workspace path" }
      }
      return { status: "ready", repository: new Repository(workspace, top) }
    } catch (error) {
      return { status: "unavailable", reason: `could not resolve the Git repository: ${describeError(error)}` }
    }
  }

  async captureTargeted(forced: string[]): Promise<string> {
    return this.capture(forced, false)
  }

  async captureWorkspace(): Promise<string> {
    return this.capture([], true)
  }

  private async captureFull(forced: string[]): Promise<string> {
    return this.capture(forced, true)
  }

  private async capture(forced: string[], full: boolean): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "tack-git-index-"))
    const indexFile = join(directory, "index")
    try {
      const base = await runGit(this.workspace, ["rev-parse", "--verify", "HEAD^{tree}"])
      if (base.stdinError) throw base.stdinError
      if (base.exitCode === 0) {
        await checkedGit(this.workspace, ["read-tree", outputText(base)], { indexFile })
      } else {
        await checkedGit(this.workspace, ["read-tree", "--empty"], { indexFile })
      }

      if (full) {
        const untracked = nulSeparatedPaths(
          (await checkedGit(this.workspace, ["ls-files", "--others", "--exclude-standard", "-z", "--", "."])).stdout,
        )
        const oversized: string[] = []
        for (const path of untracked) {
          try {
            const stats = await lstat(join(this.workspace, path))
            if (stats.isFile() && stats.size > 2 * 1024 * 1024) oversized.push(path)
          } catch (error) {
            if (!isMissingPathError(error)) {
              throw new Error(`could not inspect untracked snapshot target ${path}: ${describeError(error)}`, {
                cause: error,
              })
            }
          }
        }
        await checkedGit(this.workspace, ["add", "-A", "--", "."], { indexFile })
        for (const path of oversized) {
          await checkedGit(this.workspace, ["update-index", "--force-remove", "--", path], { indexFile })
        }
      }
      for (const path of forced) {
        let exists: boolean
        try {
          await lstat(join(this.workspace, path))
          exists = true
        } catch (error) {
          if (!isMissingPathError(error)) {
            throw new Error(`could not inspect snapshot target ${path}: ${describeError(error)}`, { cause: error })
          }
          exists = false
        }
        if (exists) {
          await checkedGit(this.workspace, ["add", "-f", "-A", "--", path], { indexFile })
        } else if (!full) {
          await checkedGit(this.workspace, ["update-index", "--force-remove", "--", path], { indexFile })
        }
      }
      return outputText(await checkedGit(this.workspace, ["write-tree"], { indexFile }))
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }

  async changedPaths(before: string, after: string): Promise<string[]> {
    const output = await checkedGit(this.top, [
      "diff",
      "--name-only",
      "-z",
      "--no-renames",
      "--no-ext-diff",
      "--no-textconv",
      before,
      after,
      "--",
    ])
    return nulSeparatedPaths(output.stdout)
  }

  async indexState(paths: string[]): Promise<Buffer> {
    const output = await checkedGit(this.top, ["ls-files", "--stage", "-z", "--", ...paths])
    return output.stdout
  }

  async headState(): Promise<string> {
    const revision = await runGit(this.top, ["rev-parse", "--verify", "-q", "HEAD"])
    if (revision.stdinError) throw revision.stdinError
    if (revision.exitCode !== 0 && revision.exitCode !== 1) {
      throw new Error(commandError(revision, ["rev-parse"]))
    }
    const reference = await runGit(this.top, ["symbolic-ref", "-q", "HEAD"])
    if (reference.stdinError) throw reference.stdinError
    if (reference.exitCode !== 0 && reference.exitCode !== 1) {
      throw new Error(commandError(reference, ["symbolic-ref"]))
    }
    return `${revision.exitCode === 0 ? outputText(revision) : ""}\0${reference.exitCode === 0 ? outputText(reference) : ""}`
  }

  async gitlinks(before: string, after: string, paths: string[]): Promise<Gitlink[]> {
    const links: Gitlink[] = []
    for (const path of paths) {
      const beforeEntry = await this.treeEntry(before, path)
      const afterEntry = await this.treeEntry(after, path)
      if (beforeEntry?.mode === "160000" && afterEntry?.mode === "160000") {
        links.push({ path, before: beforeEntry.object, after: afterEntry.object })
        continue
      }
      if (beforeEntry?.mode === "160000" || afterEntry?.mode === "160000") {
        if (!beforeEntry || !afterEntry) {
          throw new Error(`added or removed submodule ${path} cannot be snapshotted safely`)
        }
        throw new Error(`replaced submodule ${path} cannot be snapshotted safely`)
      }
    }
    return links
  }

  async restore(snapshot: Snapshot): Promise<void> {
    await this.applySnapshot(snapshot, true)
  }

  async reapply(snapshot: Snapshot): Promise<void> {
    await this.applySnapshot(snapshot, false)
  }

  private async treeEntry(tree: string, path: string): Promise<TreeEntry | undefined> {
    const output = (await checkedGit(this.top, ["ls-tree", "-z", tree, "--", path])).stdout
    if (output.length === 0) return undefined
    if (output[output.length - 1] !== 0) throw new Error("git ls-tree returned a malformed entry")
    const tab = output.indexOf(9)
    if (tab < 0) throw new Error("git ls-tree returned a malformed entry")
    const fields = decode(output.subarray(0, tab), "git ls-tree returned a malformed entry").trim().split(/\s+/)
    if (fields.length !== 3 || !fields[0] || !fields[2]) throw new Error("git ls-tree returned a malformed entry")
    return { mode: fields[0], object: fields[2] }
  }

  private async applySnapshot(snapshot: Snapshot, reverse: boolean): Promise<void> {
    const currentIndex = await this.indexState(snapshot.paths)
    if (!currentIndex.equals(snapshot.index)) {
      if (reverse) {
        throw new Error(
          "Git index entries for the last agent change were staged afterward; the index and worktree were left intact.",
        )
      }
      throw new Error(
        `Git index entries were staged after undo for: ${snapshot.paths.join(", ")}. The index and worktree were left intact.`,
      )
    }

    const current = await this.captureFull(snapshot.forced)
    const expected = reverse ? snapshot.after : snapshot.before
    const verification = await runGit(this.top, [
      "diff",
      "--quiet",
      "--no-ext-diff",
      "--no-textconv",
      expected,
      current,
      "--",
      ...snapshot.paths,
    ])
    if (verification.stdinError) throw verification.stdinError
    if (verification.exitCode === 1) {
      if (reverse) {
        throw new Error("files from the last agent change were edited afterward; those edits were left intact.")
      }
      throw new Error(`files were edited after undo: ${snapshot.paths.join(", ")}. Those edits were left intact.`)
    }
    if (verification.exitCode !== 0) throw new Error(commandError(verification, ["diff"]))

    for (const link of snapshot.gitlinks) {
      await this.preflightGitlink(link, reverse ? link.before : link.after)
    }

    const gitlinkPaths = new Set(snapshot.gitlinks.map((link) => link.path))
    const regular = snapshot.paths.filter((path) => !gitlinkPaths.has(path))
    const patch =
      regular.length === 0
        ? Buffer.alloc(0)
        : (
            await checkedGit(this.top, [
              "diff",
              "--binary",
              "--full-index",
              "--no-renames",
              "--no-ext-diff",
              "--no-textconv",
              snapshot.before,
              snapshot.after,
              "--",
              ...regular,
            ])
          ).stdout

    if (patch.length > 0) await this.applyPatch(patch, reverse)
    const changedLinks: Gitlink[] = []
    for (const link of snapshot.gitlinks) {
      try {
        await this.checkoutGitlink(link, reverse ? link.before : link.after)
        changedLinks.push(link)
      } catch (error) {
        const rollbackFailures: string[] = []
        for (const changed of [...changedLinks, link].toReversed()) {
          try {
            await this.checkoutGitlink(changed, reverse ? changed.after : changed.before)
          } catch (rollbackError) {
            rollbackFailures.push(describeError(rollbackError))
          }
        }
        if (patch.length > 0) {
          try {
            await this.applyPatch(patch, !reverse)
          } catch (rollbackError) {
            rollbackFailures.push(describeError(rollbackError))
          }
        }
        if (rollbackFailures.length > 0) {
          throw new Error(
            `${describeError(error)}; restoring the pre-apply worktree also failed: ${rollbackFailures.join("; ")}`,
            { cause: error },
          )
        }
        throw error
      }
    }
  }

  private async preflightGitlink(gitlink: Gitlink, revision: string): Promise<void> {
    const path = join(this.top, gitlink.path)
    const status = await checkedGit(path, ["status", "--porcelain", "--untracked-files=all"])
    if (status.stdout.length > 0) {
      throw new Error(`submodule ${gitlink.path} has later worktree changes; they were left intact.`)
    }
    await checkedGit(path, ["cat-file", "-e", `${revision}^{commit}`])
  }

  private async checkoutGitlink(gitlink: Gitlink, revision: string): Promise<void> {
    await checkedGit(join(this.top, gitlink.path), ["checkout", "--detach", "--quiet", revision])
  }

  private async applyPatch(patch: Buffer, reverse: boolean): Promise<void> {
    await checkedGit(this.top, ["apply", ...(reverse ? ["--reverse"] : []), "--binary", "--whitespace=nowarn"], {
      input: patch,
    })
  }
}

class UndoCore {
  private readonly repository: Promise<RepositoryDiscovery>
  private readonly snapshots: Snapshot[] = []
  private checkpoints: PromptCheckpoint[] = []
  private branchValue = 0
  private epoch = 0
  private busy: BusyState | undefined
  private captureTail: Promise<void> = Promise.resolve()
  private pendingCaptures = 0

  constructor(
    private readonly workspace: string,
    private readonly requestedWorkspace: string,
  ) {
    this.repository = Repository.discover(workspace)
  }

  get branch(): number {
    return this.branchValue
  }

  seed(prompts: Array<{ messageId: string; prompt: string }>): void {
    this.assertPromptMutationAvailable()
    const snapshot = this.snapshots.length
    this.incrementBranch()
    this.checkpoints = prompts.map(({ messageId, prompt }) => ({
      messageId,
      prompt,
      snapshot,
      available: false,
      unavailable: "code before this process resumed was not captured",
    }))
  }

  markPrompt(messageId: string, prompt: string): void {
    this.assertPromptMutationAvailable()
    this.incrementBranch()
    this.checkpoints.push({
      messageId,
      prompt,
      snapshot: this.snapshots.length,
      available: true,
    })
  }

  async previews(): Promise<UndoPreview[]> {
    const discovery = await this.repository
    return this.checkpoints.map((checkpoint) => {
      if (!checkpoint.available) {
        return {
          messageId: checkpoint.messageId,
          prompt: checkpoint.prompt,
          paths: [],
          codeAvailable: false,
          ...(checkpoint.unavailable ? { unavailable: checkpoint.unavailable } : {}),
        }
      }
      if (discovery.status === "unavailable") {
        return {
          messageId: checkpoint.messageId,
          prompt: checkpoint.prompt,
          paths: [],
          codeAvailable: false,
          unavailable: discovery.reason,
        }
      }
      if (checkpoint.snapshot > this.snapshots.length) throw new Error("undo checkpoint state is inconsistent")
      const paths = new Set<string>()
      for (const snapshot of this.snapshots.slice(checkpoint.snapshot)) {
        for (const path of snapshot.paths) paths.add(path)
      }
      return {
        messageId: checkpoint.messageId,
        prompt: checkpoint.prompt,
        paths: [...paths].sort(),
        codeAvailable: true,
      }
    })
  }

  async trackPaths<T>(tool: string, paths: string[], operation: () => Promise<T>): Promise<T> {
    const discovery = await this.repository
    if (discovery.status === "unavailable" || paths.length === 0) return operation()

    const forced = this.relativeTargets(paths)
    if (!forced) {
      this.invalidateCode(`${tool} targeted a path outside the workspace, so full undo is unavailable`)
      return operation()
    }
    if (forced.length === 0) return operation()

    return this.trackCapture(
      tool,
      discovery.repository,
      forced,
      () => discovery.repository.captureTargeted(forced),
      false,
      operation,
    )
  }

  async trackWorkspace<T>(tool: string, operation: () => Promise<T>): Promise<T> {
    const discovery = await this.repository
    if (discovery.status === "unavailable") return operation()
    return this.trackCapture(
      tool,
      discovery.repository,
      [],
      () => discovery.repository.captureWorkspace(),
      true,
      operation,
    )
  }

  private trackCapture<T>(
    tool: string,
    repository: Repository,
    forced: string[],
    capture: () => Promise<string>,
    watchIndex: boolean,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.withCaptureTurn(async () => {
      const token = Symbol("capture")
      try {
        this.acquireBusy("capture", token)
      } catch (error) {
        throw new Error(`Git snapshot failed; ${tool} was not run: ${describeError(error)}`, { cause: error })
      }
      const epoch = this.epoch
      let before: string
      let beforeIndex: Buffer | undefined
      let beforeHead: string | undefined
      try {
        before = await capture()
        if (watchIndex) {
          beforeIndex = await repository.indexState([])
          beforeHead = await repository.headState()
        }
      } catch (error) {
        this.releaseBusy(token, "capture")
        throw new Error(`Git snapshot failed; ${tool} was not run: ${describeError(error)}`, { cause: error })
      }

      let outcome: { status: "completed"; value: T } | { status: "failed"; error: unknown }
      try {
        outcome = { status: "completed", value: await operation() }
      } catch (error) {
        outcome = { status: "failed", error }
      }

      let finishError: unknown
      try {
        if (this.epoch === epoch) {
          const after = await capture()
          const afterIndex = watchIndex ? await repository.indexState([]) : undefined
          const afterHead = watchIndex ? await repository.headState() : undefined
          if (beforeHead !== undefined && afterHead !== undefined && beforeHead !== afterHead) {
            this.invalidateCode("Git HEAD changed during a shell command, so full undo is unavailable")
          } else if (beforeIndex && afterIndex && !beforeIndex.equals(afterIndex)) {
            this.invalidateCode("the Git index changed during a shell command, so full undo is unavailable")
          } else {
            const changed = await repository.changedPaths(before, after)
            const index = await repository.indexState(changed)
            const gitlinks = await repository.gitlinks(before, after, changed)
            if (this.epoch === epoch && changed.length > 0) {
              this.snapshots.push({ before, after, paths: changed, index, gitlinks, forced })
              this.incrementBranch()
            }
          }
        }
      } catch (error) {
        finishError = error
      } finally {
        this.releaseBusy(token, "capture")
      }

      if (this.epoch !== epoch) finishError = undefined
      if (finishError !== undefined) {
        this.invalidateCode(`${tool} changes could not be captured, so full undo is unavailable`)
      }
      if (outcome.status === "failed") {
        if (finishError !== undefined) {
          throw new AggregateError(
            [outcome.error, finishError],
            `${tool} failed, and its undo snapshot could not be recorded: ${describeError(finishError)}`,
          )
        }
        throw outcome.error
      }
      if (finishError !== undefined) {
        throw new Error(
          `${tool} completed, but its undo snapshot could not be recorded: ${describeError(finishError)}`,
          {
            cause: finishError,
          },
        )
      }
      return outcome.value
    })
  }

  async trackInvalidation<T>(operation: () => Promise<T>): Promise<T> {
    if (this.busy && this.busy.kind !== "capture") {
      throw new Error("workspace invalidation is unavailable while code undo or redo is being applied")
    }
    this.invalidateCode("background shell changes cannot be captured, so full undo is unavailable")
    return operation()
  }

  async rewind(messageId: string): Promise<CodeRewind> {
    const discovery = await this.repository
    if (discovery.status === "unavailable") {
      throw new Error(`code undo requires a Git repository: ${discovery.reason}`)
    }
    if (this.busy || this.pendingCaptures > 0) {
      throw new Error("undo is unavailable while agent tools are running")
    }
    const checkpointPosition = this.checkpoints.findIndex((checkpoint) => checkpoint.messageId === messageId)
    if (checkpointPosition < 0) throw new Error("code for that checkpoint is no longer available")
    const checkpoint = this.checkpoints[checkpointPosition]
    if (!checkpoint) throw new Error("code for that checkpoint is no longer available")
    if (!checkpoint.available) {
      throw new Error(checkpoint.unavailable ?? "code for that checkpoint is no longer available")
    }
    if (checkpoint.snapshot > this.snapshots.length) throw new Error("code for that checkpoint is stale")

    const snapshots = this.snapshots.slice(checkpoint.snapshot)
    const checkpoints = this.checkpoints.slice(checkpointPosition)
    const token = Symbol("rewind")
    this.acquireBusy("rewind", token)
    try {
      await applyAtomically(
        snapshots.toReversed(),
        (snapshot) => discovery.repository.restore(snapshot),
        (snapshot) => discovery.repository.reapply(snapshot),
        "restoring the pre-undo worktree also failed",
      )
    } catch (error) {
      this.releaseBusy(token, "rewind")
      throw error
    }

    this.snapshots.length = checkpoint.snapshot
    this.checkpoints.length = checkpointPosition
    return new CodeRewind(this, {
      snapshots,
      checkpoints,
      snapshotPosition: checkpoint.snapshot,
      checkpointPosition,
      branch: this.branchValue,
      token,
    })
  }

  commitRewind(transaction: RewindTransaction): CodeRedo[] {
    this.assertTransaction(transaction.token, "rewind")
    this.assertRewoundPosition(transaction)
    const redos = transaction.checkpoints.map((checkpoint, index) => {
      const start = checkpoint.snapshot - transaction.snapshotPosition
      const end =
        (transaction.checkpoints[index + 1]?.snapshot ?? transaction.snapshotPosition + transaction.snapshots.length) -
        transaction.snapshotPosition
      return new CodeRedo(this, {
        snapshots: transaction.snapshots.slice(start, end),
        checkpoints: [checkpoint],
        snapshotPosition: checkpoint.snapshot,
        checkpointPosition: transaction.checkpointPosition + index,
        branch: transaction.branch,
      })
    })
    this.releaseBusy(transaction.token, "rewind")
    return redos
  }

  async rollbackRewind(transaction: RewindTransaction): Promise<void> {
    this.assertTransaction(transaction.token, "rewind")
    this.assertRewoundPosition(transaction)
    const discovery = await this.readyRepository()
    try {
      await applyAtomically(
        transaction.snapshots,
        (snapshot) => discovery.reapply(snapshot),
        (snapshot) => discovery.restore(snapshot),
        "restoring the rewound worktree also failed",
      )
      this.snapshots.push(...transaction.snapshots)
      this.checkpoints.push(...transaction.checkpoints)
    } finally {
      this.releaseBusy(transaction.token, "rewind")
    }
  }

  async applyRedo(transaction: RedoTransaction): Promise<AppliedCodeRedo> {
    const discovery = await this.readyRepository()
    if (this.busy || this.pendingCaptures > 0) {
      throw new Error("redo is unavailable while agent tools are running")
    }
    if (this.branchValue !== transaction.branch || this.snapshots.length !== transaction.snapshotPosition) {
      throw new Error("a new prompt or agent change created a divergent branch")
    }
    const token = Symbol("redo")
    this.acquireBusy("redo", token)
    try {
      await applyAtomically(
        transaction.snapshots,
        (snapshot) => discovery.reapply(snapshot),
        (snapshot) => discovery.restore(snapshot),
        "restoring the undone worktree also failed",
      )
    } catch (error) {
      this.releaseBusy(token, "redo")
      throw error
    }
    return new AppliedCodeRedo(this, transaction, token)
  }

  commitRedo(transaction: RedoTransaction, token: symbol): void {
    this.assertTransaction(token, "redo")
    this.assertRedoPosition(transaction)
    this.snapshots.push(...transaction.snapshots)
    this.checkpoints.push(...transaction.checkpoints)
    this.releaseBusy(token, "redo")
  }

  async rollbackRedo(transaction: RedoTransaction, token: symbol): Promise<void> {
    this.assertTransaction(token, "redo")
    this.assertRedoPosition(transaction)
    const discovery = await this.readyRepository()
    try {
      await applyAtomically(
        transaction.snapshots.toReversed(),
        (snapshot) => discovery.restore(snapshot),
        (snapshot) => discovery.reapply(snapshot),
        "restoring the redone worktree also failed",
      )
    } finally {
      this.releaseBusy(token, "redo")
    }
  }

  private relativeTargets(paths: string[]): string[] | undefined {
    const targets = new Set<string>()
    for (const path of paths) {
      if (!path) return undefined
      let absolute = isAbsolute(path) ? resolve(path) : resolve(this.workspace, path)
      if (!pathIsInside(this.workspace, absolute) && pathIsInside(this.requestedWorkspace, absolute)) {
        absolute = resolve(this.workspace, relative(this.requestedWorkspace, absolute))
      }
      if (!pathIsInside(this.workspace, absolute)) return undefined
      absolute = canonicalTarget(absolute)
      if (!pathIsInside(this.workspace, absolute)) return undefined
      const target = relative(this.workspace, absolute)
      if (!target) return undefined
      targets.add(gitPath(target))
    }
    return [...targets].sort()
  }

  private withCaptureTurn<T>(operation: () => Promise<T>): Promise<T> {
    this.pendingCaptures++
    const previous = this.captureTail
    let release = (): void => {
      throw new Error("capture queue was not initialized")
    }
    this.captureTail = new Promise<void>((resolveTurn) => {
      release = () => resolveTurn()
    })
    return previous.then(async () => {
      try {
        return await operation()
      } finally {
        this.pendingCaptures--
        release()
      }
    })
  }

  private acquireBusy(kind: BusyState["kind"], token: symbol): void {
    if (this.busy) throw new Error("another Git snapshot is already in progress")
    this.busy = { kind, token }
  }

  private releaseBusy(token: symbol, kind: BusyState["kind"]): void {
    this.assertTransaction(token, kind)
    this.busy = undefined
  }

  private assertTransaction(token: symbol, kind: BusyState["kind"]): void {
    if (this.busy?.token === token && this.busy.kind === kind) return
    throw new Error(`code ${kind} transaction is no longer active`)
  }

  private assertPromptMutationAvailable(): void {
    if (!this.busy && this.pendingCaptures === 0) return
    throw new Error("a prompt checkpoint cannot be changed while an agent tool or code undo is running")
  }

  private assertRewoundPosition(transaction: RewindTransaction): void {
    if (
      this.snapshots.length === transaction.snapshotPosition &&
      this.checkpoints.length === transaction.checkpointPosition
    ) {
      return
    }
    throw new Error("the code rewind transaction is stale")
  }

  private assertRedoPosition(transaction: RedoTransaction): void {
    if (
      this.branchValue === transaction.branch &&
      this.snapshots.length === transaction.snapshotPosition &&
      this.checkpoints.length === transaction.checkpointPosition
    ) {
      return
    }
    throw new Error("a new prompt or agent change created a divergent branch")
  }

  private async readyRepository(): Promise<Repository> {
    const discovery = await this.repository
    if (discovery.status === "ready") return discovery.repository
    throw new Error(`code undo requires a Git repository: ${discovery.reason}`)
  }

  private incrementBranch(): void {
    this.branchValue = this.increment(this.branchValue)
  }

  private invalidateCode(reason: string): void {
    this.epoch = this.increment(this.epoch)
    this.incrementBranch()
    for (const checkpoint of this.checkpoints) {
      checkpoint.available = false
      checkpoint.unavailable = reason
    }
  }

  private increment(value: number): number {
    return value === Number.MAX_SAFE_INTEGER ? 0 : value + 1
  }
}

export class WorkspaceUndo {
  private readonly core: UndoCore

  constructor(cwd: string) {
    const requestedWorkspace = resolve(cwd)
    this.core = new UndoCore(canonicalPath(requestedWorkspace), requestedWorkspace)
  }

  get branch(): number {
    return this.core.branch
  }

  seed(prompts: Array<{ messageId: string; prompt: string }>): void {
    this.core.seed(prompts)
  }

  markPrompt(messageId: string, prompt: string): void {
    this.core.markPrompt(messageId, prompt)
  }

  previews(): Promise<UndoPreview[]> {
    return this.core.previews()
  }

  trackPaths<T>(tool: string, paths: string[], operation: () => Promise<T>): Promise<T> {
    return this.core.trackPaths(tool, paths, operation)
  }

  trackWorkspace<T>(tool: string, operation: () => Promise<T>): Promise<T> {
    return this.core.trackWorkspace(tool, operation)
  }

  trackInvalidation<T>(operation: () => Promise<T>): Promise<T> {
    return this.core.trackInvalidation(operation)
  }

  rewind(messageId: string): Promise<CodeRewind> {
    return this.core.rewind(messageId)
  }
}

export class CodeRewind {
  readonly count: number
  readonly steps: number
  private settled = false

  constructor(
    private readonly core: UndoCore,
    private readonly transaction: RewindTransaction,
  ) {
    this.count = new Set(transaction.snapshots.flatMap((snapshot) => snapshot.paths)).size
    this.steps = transaction.checkpoints.length
  }

  commit(): CodeRedo[] {
    if (this.settled) throw new Error("code rewind is no longer active")
    const redo = this.core.commitRewind(this.transaction)
    this.settled = true
    return redo
  }

  async rollback(): Promise<void> {
    if (this.settled) throw new Error("code rewind is no longer active")
    try {
      await this.core.rollbackRewind(this.transaction)
    } finally {
      this.settled = true
    }
  }
}

export class CodeRedo {
  readonly count: number

  constructor(
    private readonly core: UndoCore,
    private readonly transaction: RedoTransaction,
  ) {
    this.count = new Set(transaction.snapshots.flatMap((snapshot) => snapshot.paths)).size
  }

  apply(): Promise<AppliedCodeRedo> {
    return this.core.applyRedo(this.transaction)
  }
}

export class AppliedCodeRedo {
  private settled = false

  constructor(
    private readonly core: UndoCore,
    private readonly transaction: RedoTransaction,
    private readonly token: symbol,
  ) {}

  commit(): void {
    if (this.settled) throw new Error("applied code redo is no longer active")
    this.core.commitRedo(this.transaction, this.token)
    this.settled = true
  }

  async rollback(): Promise<void> {
    if (this.settled) throw new Error("applied code redo is no longer active")
    try {
      await this.core.rollbackRedo(this.transaction, this.token)
    } finally {
      this.settled = true
    }
  }
}
