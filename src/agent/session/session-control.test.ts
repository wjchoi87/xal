import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { contributeRules } from "../../permissions/rules"
import { registerTool, unregisterTool } from "../../tools/registry"
import type { ElicitationResult, InteractiveTool, Tool } from "../../tools/types"
import type { AgentEvent } from "../events"
import { summaryMessage } from "../history"
import {
  completedRound,
  round,
  runSettledTurn,
  ScriptedProvider,
  setupAgentSessionTests,
  toolRound,
  type AgentSessionTestHarness,
  type ProviderRound,
} from "./test-support"

let harness: AgentSessionTestHarness

beforeAll(async () => {
  harness = await setupAgentSessionTests("tack-agent-session-control-test-")
})

afterAll(async () => {
  await harness.cleanup()
})

function latch(): { promise: Promise<void>; release(): void } {
  let release = (): void => {
    throw new Error("latch released before initialization")
  }
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

function longNovelResponse(stem: string): string {
  return Array.from({ length: 4_000 }, (_, index) => `${stem}${index}`).join(" ")
}

describe("AgentSession control flow", () => {
  test("drains queued prompts into the active turn without losing their order", async () => {
    const entered = latch()
    const release = latch()
    const firstRound = completedRound("First response")
    const delayedFirstRound: ProviderRound = async function* (request) {
      entered.release()
      await release.promise
      yield* firstRound(request)
    }
    const provider = new ScriptedProvider([delayedFirstRound, completedRound("Combined response")])
    const session = harness.createSession(provider)
    const observed: AgentEvent[] = []

    const running = runSettledTurn(session, { text: "First prompt", images: [] }, (event) => {
      observed.push(event)
    })
    await entered.promise
    const secondAccepted = session.send({ text: "Second prompt", images: [] })
    const thirdAccepted = session.send({ text: "Third prompt", images: [] })
    release.release()

    const outcome = await running

    expect(secondAccepted).toBe(true)
    expect(thirdAccepted).toBe(true)
    expect(outcome).toEqual({
      status: "completed",
      response: "Combined response",
      usage: undefined,
      context: undefined,
    })
    expect(provider.requests).toHaveLength(2)
    expect(provider.requests[1]?.input).toEqual([
      { type: "user_message", text: "First prompt", images: [] },
      { type: "assistant_message", text: "First response" },
      { type: "user_message", text: "Second prompt", images: [] },
      { type: "user_message", text: "Third prompt", images: [] },
    ])
    expect(observed.filter((event) => event.type === "user_message").map((event) => event.text)).toEqual([
      "First prompt",
      "Second prompt",
      "Third prompt",
    ])
    expect(observed.filter((event) => event.type === "queue_changed").map((event) => event.entries)).toEqual([
      [{ text: "Second prompt", imageCount: 0 }],
      [
        { text: "Second prompt", imageCount: 0 },
        { text: "Third prompt", imageCount: 0 },
      ],
      [],
    ])
    expect(observed.filter((event) => event.type === "queue_flushed")).toHaveLength(0)
  })

  test("manually compacts long history and uses only the summary on the next turn", async () => {
    const longResponse = longNovelResponse("compactionconcept")
    const provider = new ScriptedProvider([
      completedRound(longResponse),
      completedRound("Condensed history"),
      completedRound("Continued from the summary"),
    ])
    const session = harness.createSession(provider)
    const observed: AgentEvent[] = []
    const unsubscribe = session.subscribe((event) => observed.push(event))

    try {
      await runSettledTurn(session, { text: "Build the original feature", images: [] })

      expect(await session.compact("remaining implementation work")).toBe("compacted")
      expect(session.currentState).toBe("idle")
      expect(provider.requests[1]?.input.at(-1)).toEqual({
        type: "user_message",
        text: "Summarize the conversation above so that work can continue after the earlier messages are dropped.\n\nFocus the summary on: remaining implementation work",
        images: [],
      })
      expect(observed.filter((event) => event.type === "compacted")).toEqual([
        {
          type: "compacted",
          summary: "Condensed history",
          replaced: 2,
          tokensBefore: undefined,
        },
      ])

      const outcome = await runSettledTurn(session, { text: "Continue", images: [] })

      expect(outcome).toEqual({
        status: "completed",
        response: "Continued from the summary",
        usage: undefined,
        context: undefined,
      })
      expect(provider.requests[2]?.input).toEqual([
        summaryMessage("Condensed history"),
        { type: "user_message", text: "Continue", images: [] },
      ])
    } finally {
      unsubscribe()
    }
  })

  test("leaves history unchanged when manual compaction returns no summary", async () => {
    const longResponse = longNovelResponse("preservedconcept")
    const provider = new ScriptedProvider([
      completedRound(longResponse),
      round([{ type: "done" }]),
      completedRound("Continued with original history"),
    ])
    const session = harness.createSession(provider)

    await runSettledTurn(session, { text: "Keep this context", images: [] })
    await expect(session.compact()).rejects.toThrow("Scripted provider returned an empty summary")
    expect(session.currentState).toBe("idle")

    await runSettledTurn(session, { text: "Continue unchanged", images: [] })

    expect(provider.requests[2]?.input).toEqual([
      { type: "user_message", text: "Keep this context", images: [] },
      { type: "assistant_message", text: longResponse },
      { type: "user_message", text: "Continue unchanged", images: [] },
    ])
  })

  test("automatically compacts a full context before the next provider round", async () => {
    const longResponse = Array.from({ length: 200 }, (_, index) => `autoconcept${index}`).join(" ")
    const provider = new ScriptedProvider(
      [
        completedRound(longResponse, { totalInputTokens: 90 }),
        completedRound("Automatic summary"),
        completedRound("Continued after automatic compaction"),
      ],
      100,
    )
    const session = harness.createSession(provider)
    const observed: AgentEvent[] = []

    await runSettledTurn(session, { text: "Fill the context", images: [] })
    const outcome = await runSettledTurn(session, { text: "Continue after it fills", images: [] }, (event) => {
      observed.push(event)
    })

    expect(outcome).toEqual({
      status: "completed",
      response: "Continued after automatic compaction",
      usage: undefined,
      context: undefined,
    })
    expect(provider.requests).toHaveLength(3)
    expect(provider.requests[1]?.input).toEqual([
      { type: "user_message", text: "Fill the context", images: [] },
      { type: "assistant_message", text: longResponse },
      {
        type: "user_message",
        text: "Summarize the conversation above so that work can continue after the earlier messages are dropped.",
        images: [],
      },
    ])
    expect(provider.requests[2]?.input).toEqual([
      summaryMessage("Automatic summary"),
      { type: "user_message", text: "Continue after it fills", images: [] },
    ])
    expect(observed.filter((event) => event.type === "compacted")).toEqual([
      {
        type: "compacted",
        summary: "Automatic summary",
        replaced: 2,
        tokensBefore: 90,
      },
    ])
  })

  test("interrupts a pending approval and settles without executing the tool", async () => {
    const toolName = `approval_interrupt_${crypto.randomUUID().replaceAll("-", "_")}`
    contributeRules({ ask: [toolName] })
    let executions = 0
    const tool: Tool = {
      name: toolName,
      description: "Mutate a value",
      parameters: { type: "object" },
      title: () => "Mutate value",
      readOnly: () => false,
      execute: async () => {
        executions += 1
        return { output: "changed" }
      },
    }
    const provider = new ScriptedProvider([toolRound("approval-call", toolName, {})])
    const session = harness.createSession(provider)
    const observed: AgentEvent[] = []

    registerTool(tool)
    try {
      const outcome = await runSettledTurn(session, { text: "Make a change", images: [] }, (event) => {
        observed.push(event)
        if (event.type === "approval_requested") session.interrupt()
      })

      expect(outcome).toEqual({ status: "interrupted", response: "" })
      expect(session.currentState).toBe("idle")
      expect(executions).toBe(0)
      expect(provider.requests).toHaveLength(1)
      expect(observed.filter((event) => event.type === "approval_requested")).toHaveLength(1)
      expect(observed.filter((event) => event.type === "tool_started")).toHaveLength(0)
      expect(observed.filter((event) => event.type === "tool_finished")).toEqual([
        {
          type: "tool_finished",
          callId: "approval-call",
          tool: toolName,
          title: "Mutate value",
          readOnly: false,
          output: "User denied permission to run this action.",
          denial: "user",
        },
      ])
      expect(observed.filter((event) => event.type === "turn_interrupted")).toHaveLength(1)
    } finally {
      unregisterTool(tool)
    }
  })

  test("corrects missing and invalid structured output before accepting a valid value", async () => {
    const provider = new ScriptedProvider([
      completedRound("The answer is three."),
      toolRound("invalid-output", "submit_output", { count: "three" }),
      toolRound("valid-output", "submit_output", { count: 3 }),
    ])
    const session = harness.createSession(provider, {
      outputSchema: {
        type: "object",
        properties: { count: { type: "integer" } },
        required: ["count"],
        additionalProperties: false,
      },
    })
    const observed: AgentEvent[] = []

    const outcome = await runSettledTurn(session, { text: "Return a count", images: [] }, (event) => {
      observed.push(event)
    })

    expect(outcome).toEqual({
      status: "completed",
      response: { count: 3 },
      usage: undefined,
      context: undefined,
    })
    expect(provider.requests).toHaveLength(3)
    expect(provider.requests[1]?.input.at(-1)).toEqual({
      type: "user_message",
      text: "The previous response did not call submit_output. Correct the final value and retry; 2 attempts remain.",
      images: [],
    })
    const invalidResult = provider.requests[2]?.input.at(-1)
    expect(invalidResult?.type).toBe("tool_result")
    if (invalidResult?.type !== "tool_result") throw new Error("missing invalid structured output result")
    expect(invalidResult.output).toContain("Structured output rejected:")
    expect(invalidResult.output).toContain("1 attempt remains")
    expect(observed.filter((event) => event.type === "tool_finished").map((event) => event.output)).toEqual([
      invalidResult.output,
      "Structured output accepted.",
    ])
  })

  test("denies mutating tools in plan mode without requesting approval", async () => {
    const toolName = `plan_write_${crypto.randomUUID().replaceAll("-", "_")}`
    let executions = 0
    const tool: Tool = {
      name: toolName,
      description: "Write a value",
      parameters: { type: "object" },
      title: () => "Write value",
      readOnly: () => false,
      execute: async () => {
        executions += 1
        return { output: "changed" }
      },
    }
    const provider = new ScriptedProvider([
      toolRound("plan-call", toolName, {}),
      completedRound("I will keep this plan read-only."),
    ])
    const session = harness.createSession(provider)
    const observed: AgentEvent[] = []

    session.setMode("plan")
    registerTool(tool)
    try {
      const outcome = await runSettledTurn(session, { text: "Investigate only", images: [] }, (event) => {
        observed.push(event)
      })

      expect(outcome.status).toBe("completed")
      expect(executions).toBe(0)
      expect(observed.filter((event) => event.type === "approval_requested")).toHaveLength(0)
      expect(observed.filter((event) => event.type === "tool_started")).toHaveLength(0)
      expect(observed.filter((event) => event.type === "tool_finished")).toEqual([
        {
          type: "tool_finished",
          callId: "plan-call",
          tool: toolName,
          title: "Write value",
          readOnly: false,
          output:
            "Plan mode is active, so this action was not run. Finish investigating and present a plan instead of retrying.",
          denial: "plan",
        },
      ])
      expect(provider.requests[1]?.input.at(-1)).toEqual({
        type: "tool_result",
        callId: "plan-call",
        output:
          "Plan mode is active, so this action was not run. Finish investigating and present a plan instead of retrying.",
      })
    } finally {
      unregisterTool(tool)
    }
  })

  test("returns a tool failure to the model so the turn can recover", async () => {
    const toolName = `failing_read_${crypto.randomUUID().replaceAll("-", "_")}`
    const tool: Tool = {
      name: toolName,
      description: "Read a value",
      parameters: { type: "object" },
      title: () => "Read value",
      readOnly: () => true,
      execute: async () => {
        throw new Error("critical operation failed")
      },
    }
    const provider = new ScriptedProvider([
      toolRound("failure-call", toolName, {}),
      completedRound("Recovered without the tool."),
    ])
    const session = harness.createSession(provider)
    const observed: AgentEvent[] = []

    registerTool(tool)
    try {
      const outcome = await runSettledTurn(session, { text: "Read the value", images: [] }, (event) => {
        observed.push(event)
      })

      expect(outcome).toEqual({
        status: "completed",
        response: "Recovered without the tool.",
        usage: undefined,
        context: undefined,
      })
      expect(provider.requests[1]?.input.at(-1)).toEqual({
        type: "tool_result",
        callId: "failure-call",
        output: "Tool failed: critical operation failed",
      })
      expect(observed.filter((event) => event.type === "tool_started")).toHaveLength(1)
      expect(observed.filter((event) => event.type === "tool_finished")).toEqual([
        {
          type: "tool_finished",
          callId: "failure-call",
          tool: toolName,
          title: "Read value",
          readOnly: true,
          output: "Tool failed: critical operation failed",
        },
      ])
      expect(observed.filter((event) => event.type === "turn_failed")).toHaveLength(0)
    } finally {
      unregisterTool(tool)
    }
  })

  test("validates and normalizes interactive elicitation answers", async () => {
    const toolName = `interactive_answer_${crypto.randomUUID().replaceAll("-", "_")}`
    const longAnswer = "x".repeat(501)
    let received: ElicitationResult | undefined
    const tool: InteractiveTool = {
      name: toolName,
      description: "Ask for preferences",
      parameters: { type: "object" },
      title: () => "Ask preferences",
      readOnly: () => true,
      interactive: true,
      execute: async (_args, context) => {
        received = await context.requestInput({
          questions: [
            {
              id: "editor",
              header: "Editor",
              question: "Which editor?",
              options: [
                { label: "Vim", description: "Use Vim" },
                { label: "Emacs", description: "Use Emacs" },
              ],
            },
            {
              id: "theme",
              header: "Theme",
              question: "Which theme?",
              options: [
                { label: "Dark", description: "Use dark colors" },
                { label: "Light", description: "Use light colors" },
              ],
            },
          ],
        })
        return { output: JSON.stringify(received) }
      },
    }
    const provider = new ScriptedProvider([
      toolRound("answer-call", toolName, {}),
      completedRound("Preferences saved."),
    ])
    const session = harness.createSession(provider, { interactive: true })
    const observed: AgentEvent[] = []
    const answerResults: boolean[] = []

    registerTool(tool)
    try {
      const outcome = await runSettledTurn(session, { text: "Choose preferences", images: [] }, (event) => {
        observed.push(event)
        if (event.type !== "elicitation_requested") return
        answerResults.push(session.answerElicitation("wrong-request", []))
        answerResults.push(session.answerElicitation(event.requestId, [{ questionId: "editor", value: "Vim" }]))
        answerResults.push(
          session.answerElicitation(event.requestId, [
            { questionId: "editor", value: "Vim" },
            { questionId: "editor", value: "Emacs" },
          ]),
        )
        answerResults.push(
          session.answerElicitation(event.requestId, [
            { questionId: "editor", value: "Vim" },
            { questionId: "unknown", value: "Dark" },
          ]),
        )
        answerResults.push(
          session.answerElicitation(event.requestId, [
            { questionId: "editor", value: " " },
            { questionId: "theme", value: "Dark" },
          ]),
        )
        answerResults.push(
          session.answerElicitation(event.requestId, [
            { questionId: "theme", value: " Dark " },
            { questionId: "editor", value: ` ${longAnswer} ` },
          ]),
        )
      })

      expect(outcome.status).toBe("completed")
      expect(answerResults).toEqual([false, false, false, false, false, true])
      expect(received).toEqual({
        status: "answered",
        answers: [
          { questionId: "editor", value: longAnswer },
          { questionId: "theme", value: "Dark" },
        ],
      })
      expect(observed.filter((event) => event.type === "elicitation_requested")).toHaveLength(1)
      expect(observed.filter((event) => event.type === "elicitation_resolved")).toEqual([
        { type: "elicitation_resolved", callId: "answer-call" },
      ])
      expect(provider.requests[1]?.input.at(-1)).toEqual({
        type: "tool_result",
        callId: "answer-call",
        output: JSON.stringify({
          status: "answered",
          answers: [
            { questionId: "editor", value: longAnswer },
            { questionId: "theme", value: "Dark" },
          ],
        }),
      })
    } finally {
      unregisterTool(tool)
    }
  })

  test("lets an interactive client reject elicitation and continue the turn", async () => {
    const toolName = `interactive_reject_${crypto.randomUUID().replaceAll("-", "_")}`
    let received: ElicitationResult | undefined
    const tool: InteractiveTool = {
      name: toolName,
      description: "Ask for confirmation",
      parameters: { type: "object" },
      title: () => "Ask confirmation",
      readOnly: () => true,
      interactive: true,
      execute: async (_args, context) => {
        received = await context.requestInput({
          questions: [
            {
              id: "confirm",
              header: "Confirm",
              question: "Continue?",
              options: [
                { label: "Yes", description: "Continue" },
                { label: "No", description: "Stop" },
              ],
            },
          ],
        })
        return { output: JSON.stringify(received) }
      },
    }
    const provider = new ScriptedProvider([
      toolRound("reject-call", toolName, {}),
      completedRound("Stopped as requested."),
    ])
    const session = harness.createSession(provider, { interactive: true })
    const rejectionResults: boolean[] = []

    registerTool(tool)
    try {
      const outcome = await runSettledTurn(session, { text: "Ask before continuing", images: [] }, (event) => {
        if (event.type !== "elicitation_requested") return
        rejectionResults.push(session.rejectElicitation("wrong-request"))
        rejectionResults.push(session.rejectElicitation(event.requestId))
      })

      expect(outcome.status).toBe("completed")
      expect(rejectionResults).toEqual([false, true])
      expect(received).toEqual({ status: "rejected" })
      expect(provider.requests[1]?.input.at(-1)).toEqual({
        type: "tool_result",
        callId: "reject-call",
        output: '{"status":"rejected"}',
      })
    } finally {
      unregisterTool(tool)
    }
  })
})
