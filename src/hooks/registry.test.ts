import { afterEach, describe, expect, test } from "bun:test"
import type { HookAction, HookContext, HookEvent } from "./types"
import { clearHooks, registerHook, runBeforeToolHooks, runPromptHooks, type HookReporter } from "./registry"

interface Report {
  type: "started" | "finished"
  hook: string
  event: HookEvent
  action?: HookAction
}

function context(): HookContext {
  return {
    session: {
      id: "session-id",
      kind: "primary",
      cwd: "/workspace",
      provider: "provider",
      model: "model",
      mode: "normal",
    },
    signal: new AbortController().signal,
  }
}

function reporter(reports: Report[]): HookReporter {
  return {
    started(hook, event) {
      reports.push({ type: "started", hook, event })
    },
    finished(hook, event, action) {
      reports.push({ type: "finished", hook, event, action })
    },
  }
}

afterEach(() => {
  clearHooks()
})

describe("hook pipeline", () => {
  test("runs hooks in registration order and chains prompt replacements", async () => {
    const inputs: string[] = []
    const reports: Report[] = []
    registerHook("later", 1, 0, {
      name: "append",
      prompt(input: { text: string }) {
        inputs.push(input.text)
        return { type: "replace", text: `${input.text} world` }
      },
    })
    registerHook("earlier", 0, 1, {
      name: "uppercase",
      prompt(input: { text: string }) {
        inputs.push(input.text)
        return { type: "replace", text: input.text.toUpperCase() }
      },
    })

    const outcome = await runPromptHooks({ text: "hello", imageCount: 0 }, context(), reporter(reports))

    expect(outcome).toEqual({ type: "continue", text: "HELLO world" })
    expect(inputs).toEqual(["hello", "HELLO"])
    expect(reports).toEqual([
      { type: "started", hook: "earlier/uppercase", event: "prompt" },
      { type: "finished", hook: "earlier/uppercase", event: "prompt", action: "modified" },
      { type: "started", hook: "later/append", event: "prompt" },
      { type: "finished", hook: "later/append", event: "prompt", action: "modified" },
    ])
  })

  test("passes replaced tool arguments forward without mutating the caller and stops on a block", async () => {
    const original = { path: "before" }
    const seen: unknown[] = []
    const reports: Report[] = []
    registerHook("plugin", 0, 0, {
      name: "replace",
      beforeTool(input: { args: Record<string, unknown> }) {
        input.args.path = "mutated clone"
        return { type: "replace", args: { path: "after" } }
      },
    })
    registerHook("plugin", 0, 1, {
      name: "block",
      beforeTool(input: { args: Record<string, unknown> }) {
        seen.push(input.args)
        return { type: "block", reason: "unsafe target" }
      },
    })

    const outcome = await runBeforeToolHooks(
      { callId: "call-id", tool: "write", args: original },
      context(),
      reporter(reports),
    )

    expect(original).toEqual({ path: "before" })
    expect(seen).toEqual([{ path: "after" }])
    expect(outcome).toEqual({
      type: "blocked",
      hook: "plugin/block",
      reason: "unsafe target",
      args: { path: "after" },
      modified: true,
    })
    expect(reports.map(({ hook, action }) => ({ hook, action }))).toEqual([
      { hook: "plugin/replace", action: undefined },
      { hook: "plugin/replace", action: "modified" },
      { hook: "plugin/block", action: undefined },
      { hook: "plugin/block", action: "blocked" },
    ])
  })

  test("fails loudly with hook identity and reports the failed lifecycle step", async () => {
    const reports: Report[] = []
    registerHook("plugin", 0, 0, {
      name: "broken",
      prompt() {
        return "invalid"
      },
    })

    await expect(runPromptHooks({ text: "hello", imageCount: 0 }, context(), reporter(reports))).rejects.toThrow(
      'hook plugin/broken failed during prompt: prompt must return undefined, { type: "replace", text }, or { type: "reject", reason }',
    )
    expect(reports.map(({ hook, action }) => ({ hook, action }))).toEqual([
      { hook: "plugin/broken", action: undefined },
      { hook: "plugin/broken", action: "failed" },
    ])
  })
})
