import { createHash, randomUUID } from "node:crypto"
import { mkdir, realpath, unlink } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { appInfo } from "../app-info"
import { worktreesDir } from "../config/paths"
import { describeError } from "../lib/error"
import { pathExists, readJsonFile, writeSecureJson } from "../lib/fs"
import { asNumber, asString, isRecord } from "../lib/json"
import { runGit } from "./command"

export interface ManagedWorktree {
  version: 1
  repositoryRoot: string
  originalCwd: string
  path: string
  cwd: string
  branch: string
  baseCommit: string
}

const MARKER = `${appInfo.name}-worktree.json`

let mutations: Promise<void> = Promise.resolve()

function mutate<T>(action: () => Promise<T>): Promise<T> {
  const result = mutations.then(action)
  mutations = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}

function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
}

function parseManagedWorktree(value: unknown): ManagedWorktree | undefined {
  if (!isRecord(value) || asNumber(value.version) !== 1) return undefined
  const repositoryRoot = asString(value.repositoryRoot)
  const originalCwd = asString(value.originalCwd)
  const path = asString(value.path)
  const cwd = asString(value.cwd)
  const branch = asString(value.branch)
  const baseCommit = asString(value.baseCommit)
  if (!repositoryRoot || !originalCwd || !path || !cwd || !branch || !baseCommit) return undefined
  if (![repositoryRoot, originalCwd, path, cwd].every(isAbsolute)) return undefined
  return { version: 1, repositoryRoot, originalCwd, path, cwd, branch, baseCommit }
}

async function gitDirectory(cwd: string, signal?: AbortSignal): Promise<string> {
  return runGit(cwd, ["rev-parse", "--path-format=absolute", "--git-dir"], signal)
}

async function markerPath(cwd: string, signal?: AbortSignal): Promise<string> {
  return join(await gitDirectory(cwd, signal), MARKER)
}

async function primaryWorktree(cwd: string, signal?: AbortSignal): Promise<string> {
  const listing = await runGit(cwd, ["worktree", "list", "--porcelain"], signal)
  const first = listing.split("\n").find((line) => line.startsWith("worktree "))
  if (!first) throw new Error("Git did not report a primary worktree")
  return realpath(first.slice("worktree ".length))
}

async function assertClean(cwd: string, message: string, signal?: AbortSignal, includeIgnored = false): Promise<void> {
  const status = await runGit(
    cwd,
    ["status", "--porcelain", "--untracked-files=all", ...(includeIgnored ? ["--ignored"] : [])],
    signal,
  )
  if (!status) return
  throw new Error(message)
}

async function rollbackCreatedWorktree(repositoryRoot: string, path: string, branch: string): Promise<void> {
  const failures: string[] = []
  try {
    await runGit(repositoryRoot, ["worktree", "remove", "--force", path])
  } catch (error) {
    failures.push(describeError(error))
  }
  try {
    await runGit(repositoryRoot, ["branch", "-D", branch])
  } catch (error) {
    failures.push(describeError(error))
  }
  if (failures.length > 0) throw new Error(failures.join("; "))
}

export function createManagedWorktree(cwd: string, name: string, signal?: AbortSignal): Promise<ManagedWorktree> {
  return mutate(async () => {
    const currentRoot = await realpath(await runGit(cwd, ["rev-parse", "--show-toplevel"], signal))
    const repositoryRoot = await primaryWorktree(cwd, signal)
    const originalCwd = await realpath(cwd)
    const relativeCwd = relative(currentRoot, originalCwd)
    if (relativeCwd.startsWith("..") || isAbsolute(relativeCwd)) {
      throw new Error(`${originalCwd} is outside the Git worktree at ${currentRoot}`)
    }
    await assertClean(
      originalCwd,
      "workspace has uncommitted changes; commit or stash them before creating an isolated worktree",
      signal,
    )

    const baseCommit = await runGit(originalCwd, ["rev-parse", "--verify", "HEAD^{commit}"], signal)
    const suffix = randomUUID().replaceAll("-", "")
    const label = slug(name) || "workspace"
    const branch = `${appInfo.name}/${label}-${suffix}`
    const repository = createHash("sha256").update(repositoryRoot).digest("hex").slice(0, 16)
    const path = join(resolve(worktreesDir()), repository, `${label}-${suffix}`)
    await mkdir(dirname(path), { recursive: true })
    if (signal?.aborted) throw new Error("Worktree creation interrupted")
    await runGit(repositoryRoot, ["worktree", "add", "-b", branch, path, baseCommit])

    const worktree: ManagedWorktree = {
      version: 1,
      repositoryRoot,
      originalCwd,
      path,
      cwd: join(path, relativeCwd),
      branch,
      baseCommit,
    }
    try {
      if (!(await pathExists(worktree.cwd))) {
        throw new Error(`worktree checkout is missing ${worktree.cwd}`)
      }
      await writeSecureJson(await markerPath(path), worktree)
    } catch (error) {
      try {
        await rollbackCreatedWorktree(repositoryRoot, path, branch)
      } catch (rollbackError) {
        throw new Error(`${describeError(error)}; rollback failed: ${describeError(rollbackError)}`, {
          cause: rollbackError,
        })
      }
      throw error
    }
    return worktree
  })
}

export async function managedWorktreeAt(cwd: string, signal?: AbortSignal): Promise<ManagedWorktree | undefined> {
  const marker = await markerPath(cwd, signal)
  const value = await readJsonFile(marker)
  if (value === undefined) return undefined
  const parsed = parseManagedWorktree(value)
  if (!parsed) throw new Error(`${marker} has an invalid managed worktree record`)
  const root = await realpath(await runGit(cwd, ["rev-parse", "--show-toplevel"], signal))
  const recorded = await realpath(parsed.path)
  if (root !== recorded) throw new Error(`managed worktree marker does not match ${root}`)
  const relativePath = relative(await realpath(resolve(worktreesDir())), recorded)
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(`managed worktree is outside ${worktreesDir()}`)
  }
  const [currentCommon, recordedCommon] = await Promise.all([
    realpath(await runGit(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"], signal)),
    realpath(await runGit(parsed.repositoryRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"], signal)),
  ])
  if (currentCommon !== recordedCommon) throw new Error(`managed worktree repository does not match ${root}`)
  return parsed
}

export function removeManagedWorktree(worktree: ManagedWorktree, force: boolean, signal?: AbortSignal): Promise<void> {
  return mutate(async () => {
    const current = await managedWorktreeAt(worktree.path, signal)
    if (!current || current.path !== worktree.path) {
      throw new Error(`${worktree.path} is not a managed ${appInfo.displayName} worktree`)
    }
    if (!force) {
      await assertClean(
        current.path,
        "worktree has uncommitted or ignored files; preserve them or retry with force to discard them",
        signal,
        true,
      )
    }
    if (signal?.aborted) throw new Error("Worktree removal interrupted")
    await runGit(current.repositoryRoot, ["worktree", "remove", ...(force ? ["--force"] : []), current.path])
  })
}

export async function unmanageWorktree(worktree: ManagedWorktree, signal?: AbortSignal): Promise<void> {
  const current = await managedWorktreeAt(worktree.path, signal)
  if (!current || current.path !== worktree.path) {
    throw new Error(`${worktree.path} is not a managed ${appInfo.displayName} worktree`)
  }
  await unlink(await markerPath(worktree.path, signal))
}
