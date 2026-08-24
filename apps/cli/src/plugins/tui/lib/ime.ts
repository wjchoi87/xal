import type { KeyEvent } from "@opentui/core"

const IME_COMMIT_SETTLE_MS = 20

export class ImeCommitBarrier {
  private readonly settleMs: number
  private actions: (() => void)[] = []
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(settleMs = IME_COMMIT_SETTLE_MS) {
    this.settleMs = settleMs
  }

  get pending(): boolean {
    return this.actions.length > 0
  }

  enqueue(action: () => void): void {
    this.actions.push(action)
    this.arm()
  }

  observeCommit(): void {
    if (!this.pending) return
    this.arm()
  }

  clear(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    this.actions = []
  }

  private arm(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = undefined
      for (const action of this.actions.splice(0)) action()
    }, this.settleMs)
  }
}

export function isImeCommit(key: Pick<KeyEvent, "sequence" | "ctrl" | "meta" | "super" | "hyper">): boolean {
  return !key.ctrl && !key.meta && !key.super && !key.hyper && /[^\u0000-\u007f]/.test(key.sequence)
}

export interface ImeKeyDownDeps {
  barrier: ImeCommitBarrier
  insert(text: string): void
  fallback(key: KeyEvent): void
}

export function imeKeyDown(key: KeyEvent, deps: ImeKeyDownDeps): boolean {
  if (key.name === "space" && !key.ctrl && !key.meta && !key.super && !key.hyper) {
    key.preventDefault()
    deps.barrier.enqueue(() => deps.insert(key.sequence))
    return true
  }
  if (isImeCommit(key)) {
    deps.barrier.observeCommit()
    return false
  }
  if (!deps.barrier.pending) return false
  key.preventDefault()
  deps.barrier.enqueue(() => deps.fallback(key))
  return true
}
