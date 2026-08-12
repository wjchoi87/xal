import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { PermissionRequest } from "./types"

const defaultSessionKey = {}

function request(tool: string, overrides: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    sessionKey: defaultSessionKey,
    cwd: "/workspace/default",
    tool,
    title: tool,
    args: {},
    subject: undefined,
    readOnly: false,
    sandboxed: false,
    mode: "build",
    ...overrides,
  }
}

test("permission policy enforces mode, deny, configured, registered, and remembered precedence", async () => {
  const previousHome = process.env.TACK_HOME
  const home = await mkdtemp(join(tmpdir(), "tack-policy-test-"))
  process.env.TACK_HOME = home
  try {
    const { evaluatePolicy, registerPolicyRule } = await import("./service")
    const { contributeRules, rememberRule, setUserRules } = await import("./rules")
    const { saveProjectRule } = await import("./store")

    expect(await evaluatePolicy(request("default-read", { readOnly: true }))).toBe("allow")
    expect(await evaluatePolicy(request("default-sandbox", { sandboxed: true }))).toBe("allow")
    expect(await evaluatePolicy(request("default-build"))).toBe("ask")
    expect(await evaluatePolicy(request("default-plan", { mode: "plan" }))).toBe("deny")
    expect(await evaluatePolicy(request("default-auto", { mode: "auto" }))).toBe("allow")
    expect(await evaluatePolicy(request("default-yolo", { mode: "yolo" }))).toBe("allow")

    contributeRules({ allow: ["precedence(*)"] })
    setUserRules({
      allow: ["configured(safe*)"],
      ask: ["configured(review*)", "precedence(*)"],
      deny: ["configured(blocked*)"],
    })

    expect(await evaluatePolicy(request("configured", { subject: "safe/path" }))).toBe("allow")
    expect(await evaluatePolicy(request("configured", { subject: "review/path" }))).toBe("ask")
    expect(await evaluatePolicy(request("configured", { subject: "review/path", mode: "yolo" }))).toBe("allow")
    expect(
      await evaluatePolicy(
        request("configured", { subject: "blocked/path", readOnly: true, sandboxed: true, mode: "yolo" }),
      ),
    ).toBe("deny")
    expect(await evaluatePolicy(request("configured", { subject: "safe/path", mode: "plan" }))).toBe("deny")
    expect(await evaluatePolicy(request("precedence", { subject: "anything" }))).toBe("ask")

    registerPolicyRule({
      evaluate: (candidate) => (candidate.tool === "registered" ? "allow" : undefined),
    })
    registerPolicyRule({
      evaluate: (candidate) => (candidate.tool === "registered" ? "ask" : undefined),
    })
    expect(await evaluatePolicy(request("registered"))).toBe("ask")
    expect(await evaluatePolicy(request("registered", { mode: "yolo" }))).toBe("allow")

    await rememberRule(defaultSessionKey, "/workspace/default", "remembered(/workspace/*)", "session")
    expect(await evaluatePolicy(request("remembered", { subject: "/workspace/file.ts" }))).toBe("allow")
    expect(await evaluatePolicy(request("remembered", { subject: "/other/file.ts" }))).toBe("ask")
    expect(
      await evaluatePolicy(
        request("remembered", {
          cwd: "/workspace/other",
          subject: "/workspace/file.ts",
        }),
      ),
    ).toBe("ask")
    expect(
      await evaluatePolicy(
        request("remembered", {
          sessionKey: {},
          subject: "/workspace/file.ts",
        }),
      ),
    ).toBe("ask")

    await rememberRule(defaultSessionKey, "/workspace/first", "persistent", "always")
    expect(await evaluatePolicy(request("persistent", { cwd: "/workspace/first" }))).toBe("allow")
    expect(await evaluatePolicy(request("persistent", { sessionKey: {}, cwd: "/workspace/first" }))).toBe("allow")
    expect(await evaluatePolicy(request("persistent", { cwd: "/workspace/second" }))).toBe("ask")

    await saveProjectRule("/workspace/from-disk", "loaded")
    expect(await evaluatePolicy(request("loaded", { cwd: "/workspace/from-disk" }))).toBe("allow")
    expect(await evaluatePolicy(request("loaded", { cwd: "/workspace/elsewhere" }))).toBe("ask")
  } finally {
    if (previousHome === undefined) delete process.env.TACK_HOME
    else process.env.TACK_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

test("an AgentSession approval stays scoped to its session and workspace", async () => {
  const previousHome = process.env.TACK_HOME
  const home = await mkdtemp(join(tmpdir(), "tack-policy-session-test-"))
  process.env.TACK_HOME = home
  try {
    const { registerTool, unregisterTool } = await import("../tools/registry")
    const { completedRound, runSettledTurn, ScriptedProvider, setupAgentSessionTests, toolRound } =
      await import("../agent/agent-session-test-support")
    const toolName = `workspace_rule_${crypto.randomUUID().replaceAll("-", "_")}`
    let executions = 0
    const tool = {
      name: toolName,
      description: "Change workspace state",
      parameters: { type: "object" },
      title: () => "Change workspace state",
      readOnly: () => false,
      permission: () => ({ subject: "shared-subject", suggestion: `${toolName}(shared-subject)` }),
      execute: async () => {
        executions += 1
        return { output: "changed" }
      },
    }
    const provider = new ScriptedProvider([
      toolRound("first-call", toolName, {}),
      completedRound("First workspace complete"),
      toolRound("reset-call", toolName, {}),
      completedRound("Reset session complete"),
      toolRound("second-call", toolName, {}),
      completedRound("Second workspace complete"),
    ])
    const otherProvider = new ScriptedProvider([
      toolRound("other-session-call", toolName, {}),
      completedRound("Other session complete"),
    ])
    const harness = await setupAgentSessionTests("tack-policy-agent-session-test-")
    const firstWorkspace = join(home, "first-workspace")
    const secondWorkspace = join(home, "second-workspace")
    const session = harness.createSession(provider, { cwd: firstWorkspace })
    const otherSession = harness.createSession(otherProvider, { cwd: firstWorkspace })
    const approvals: string[] = []

    registerTool(tool)
    try {
      await runSettledTurn(session, { text: "Change the first workspace", images: [] }, (event) => {
        if (event.type !== "approval_requested") return
        approvals.push(`first:${session.currentWorkingDirectory}`)
        session.approve("session", event.suggestion)
      })

      await runSettledTurn(otherSession, { text: "Change from another session", images: [] }, (event) => {
        if (event.type !== "approval_requested") return
        approvals.push(`other:${otherSession.currentWorkingDirectory}`)
        otherSession.approve()
      })

      expect(session.reset()).toBe(true)
      await runSettledTurn(session, { text: "Change after reset", images: [] }, (event) => {
        if (event.type !== "approval_requested") return
        approvals.push(`reset:${session.currentWorkingDirectory}`)
        session.approve()
      })

      session.changeWorkspace(secondWorkspace)
      await runSettledTurn(session, { text: "Change the second workspace", images: [] }, (event) => {
        if (event.type !== "approval_requested") return
        approvals.push(`second:${session.currentWorkingDirectory}`)
        session.approve()
      })

      expect(approvals).toEqual([
        `first:${firstWorkspace}`,
        `other:${firstWorkspace}`,
        `reset:${firstWorkspace}`,
        `second:${secondWorkspace}`,
      ])
      expect(executions).toBe(4)
    } finally {
      unregisterTool(tool)
      await harness.cleanup()
    }
  } finally {
    if (previousHome === undefined) delete process.env.TACK_HOME
    else process.env.TACK_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})
