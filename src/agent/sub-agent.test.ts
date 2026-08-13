import { afterAll, beforeAll, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { getJob, stopJob } from "../background/jobs"
import { configureModes } from "../permissions/modes"
import type { ModelCatalog, Provider, StreamRequest } from "../providers/types"
import { registerTool, unregisterTool } from "../tools/registry"
import type { Tool } from "../tools/types"
import type { AgentEvent, BackgroundResult } from "./events"
import {
  completedRound,
  runSettledTurn,
  setupAgentSessionTests,
  toolRound,
  type AgentSessionTestHarness,
  type ProviderRound,
} from "./agent-session-test-support"
import { registerTaskAgents } from "./sub-agent"

let harness: AgentSessionTestHarness

beforeAll(async () => {
  harness = await setupAgentSessionTests("tack-sub-agent-test-")
  registerTaskAgents()
})

afterAll(async () => {
  await harness.cleanup()
})

function modelCatalog(): ModelCatalog {
  return {
    models: [{ id: "test-model", name: "Test model", inputModalities: ["text"] }],
    source: "runtime",
  }
}

test("inherits deny rules and durably delivers a bounded task report", async () => {
  const deniedToolName = `denied_mutation_${crypto.randomUUID().replaceAll("-", "_")}`
  configureModes({ guarded: { base: "yolo", rules: { deny: [deniedToolName] } } })
  let mutations = 0
  const deniedTool: Tool = {
    name: deniedToolName,
    description: "Mutation blocked by the parent mode",
    parameters: { type: "object", additionalProperties: false },
    title: () => "blocked mutation",
    readOnly: () => false,
    async execute() {
      mutations += 1
      return { output: "mutated" }
    },
  }
  registerTool(deniedTool)

  const childReady = Promise.withResolvers<void>()
  const releaseChild = Promise.withResolvers<void>()
  const report = Array.from({ length: 1_200 }, (_, index) => `verified-result-${index}`).join("\n")
  let parentSessionId = ""
  let parentRound = 0
  let childRound = 0
  let deliveredInput = ""

  const provider: Provider = {
    id: `sub-agent-test-${crypto.randomUUID()}`,
    name: "Sub-agent test provider",
    aliases: [],
    capabilities: { imageInput: false },
    async isLoggedIn() {
      return true
    },
    async listModels() {
      return modelCatalog()
    },
    async defaultModel() {
      return "test-model"
    },
    async *stream(request: StreamRequest) {
      let response: ProviderRound
      if (request.sessionId === parentSessionId) {
        parentRound += 1
        if (parentRound === 1) {
          response = toolRound("dispatch", "task", {
            context: "Verify policy inheritance and return a long report.",
            tasks: [
              {
                name: "policy_child",
                task: "Try the denied tool, then report what happened.",
                access: "write",
                isolation: "shared",
              },
            ],
          })
        } else if (parentRound === 2) {
          response = completedRound("Waiting for the task result.")
        } else if (parentRound === 3) {
          const input = request.input.findLast((item) => item.type === "user_message")
          deliveredInput = input?.type === "user_message" ? input.text : ""
          response = completedRound("Integrated the task result.")
        } else {
          throw new Error(`unexpected parent round ${parentRound}`)
        }
      } else {
        childRound += 1
        if (childRound === 1) {
          response = toolRound("denied", deniedToolName, {})
        } else if (childRound === 2) {
          childReady.resolve()
          await releaseChild.promise
          response = completedRound(report)
        } else {
          throw new Error(`unexpected child round ${childRound}`)
        }
      }
      yield* response(request)
    },
  }

  const session = harness.createSession(provider, { interactive: true })
  parentSessionId = session.id
  session.setMode("guarded")
  let delivered: BackgroundResult | undefined
  let deliverySeen = false
  const settled = Promise.withResolvers<void>()
  const observe = (event: AgentEvent): void => {
    if (event.type === "background_results") {
      delivered = event.results[0]
      deliverySeen = true
    }
    if (event.type === "state_changed" && event.state === "idle" && deliverySeen) settled.resolve()
  }
  const unsubscribe = session.subscribe(observe)

  try {
    const initial = await runSettledTurn(session, { text: "Dispatch the policy check.", images: [] })
    expect(initial.status).toBe("completed")
    expect(initial.response).toBe("Waiting for the task result.")
    await childReady.promise
    releaseChild.resolve()
    await settled.promise

    if (!delivered) throw new Error("task result was not delivered")
    const recordMatch = /^Full task record: (.+)$/m.exec(delivered.output)
    const recordPath = recordMatch?.[1]
    if (!recordPath) throw new Error("task result did not include its durable record path")
    const record = await readFile(recordPath, "utf8")

    expect(mutations).toBe(0)
    expect(childRound).toBe(2)
    expect(parentRound).toBe(3)
    expect(delivered.status).toBe("completed")
    expect(delivered.output).toContain("[Result truncated.]")
    expect(delivered.output).toContain(recordPath)
    expect(record).toContain("Status: completed")
    expect(record).toContain(report)
    expect(deliveredInput).toContain("[Result truncated.]")
    expect(deliveredInput).toContain(recordPath)
  } finally {
    releaseChild.resolve()
    unsubscribe()
    session.disposeToolResources()
    unregisterTool(deniedTool)
    configureModes({})
  }
})

test("does not wake the parent after a running task is cancelled", async () => {
  const childStarted = Promise.withResolvers<void>()
  let parentSessionId = ""
  let parentRound = 0
  const provider: Provider = {
    id: `sub-agent-cancel-test-${crypto.randomUUID()}`,
    name: "Sub-agent cancellation test provider",
    aliases: [],
    capabilities: { imageInput: false },
    async isLoggedIn() {
      return true
    },
    async listModels() {
      return modelCatalog()
    },
    async defaultModel() {
      return "test-model"
    },
    async *stream(request: StreamRequest) {
      if (request.sessionId === parentSessionId) {
        parentRound += 1
        const response =
          parentRound === 1
            ? toolRound("dispatch-cancel", "task", {
                context: "Wait until cancelled.",
                tasks: [
                  {
                    name: "cancel_child",
                    task: "Wait for cancellation.",
                    access: "read",
                    isolation: "shared",
                  },
                ],
              })
            : completedRound("Waiting for cancellation.")
        yield* response(request)
        return
      }

      childStarted.resolve()
      const signal = request.signal
      if (!signal) throw new Error("task request had no abort signal")
      if (!signal.aborted) {
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))
      }
      const error = new Error("task cancelled")
      error.name = "AbortError"
      throw error
    },
  }

  const session = harness.createSession(provider, { interactive: true })
  parentSessionId = session.id
  let deliveries = 0
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "background_results") deliveries += 1
  })

  try {
    const initial = await runSettledTurn(session, { text: "Dispatch a cancellable task.", images: [] })
    expect(initial.status).toBe("completed")
    expect(initial.response).toBe("Waiting for cancellation.")
    await childStarted.promise
    const job = getJob("cancel_child")
    if (!job || job.kind !== "agent") throw new Error("cancellable task job was not registered")

    await stopJob(job)
    await job.completion
    await Promise.resolve()

    expect(job.outcome?.status).toBe("interrupted")
    expect(job.consumed).toBe(true)
    expect(deliveries).toBe(0)
    expect(parentRound).toBe(2)
    expect(session.currentState).toBe("idle")
  } finally {
    unsubscribe()
    session.disposeToolResources()
  }
})
