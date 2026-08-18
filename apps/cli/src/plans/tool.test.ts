import { afterAll, beforeAll, expect, test } from "bun:test"
import {
  completedRound,
  round,
  ScriptedProvider,
  setupAgentSessionTests,
  type AgentSession,
  type AgentSessionTestHarness,
} from "../agent/session/test-support"
import type { AgentEvent } from "../agent/events"
import { registerTool, unregisterTool } from "../tools/registry"
import { submitPlanTool } from "./tool"

const PLAN = "# Ship the widget\n\n1. Add the widget\n2. Test the widget"

const RESTART_PROMPT =
  "A previous agent produced the plan below to accomplish the user's task. Implement the plan in a fresh context. Treat the plan as the source of user intent, re-read files as needed, and carry the work through implementation and verification."

let harness: AgentSessionTestHarness

beforeAll(async () => {
  harness = await setupAgentSessionTests("plan-tool-test-")
})

afterAll(async () => {
  await harness.cleanup()
})

function planningProvider(): ScriptedProvider {
  return new ScriptedProvider(
    [
      round([
        {
          type: "item_done",
          item: { type: "tool_call", callId: "plan-call", name: "submit_plan", args: { plan: PLAN } },
        },
        { type: "done", usage: { totalInputTokens: 4_500 } },
      ]),
      completedRound("Implemented the widget"),
    ],
    10_000,
  )
}

function reviewSession(provider: ScriptedProvider): AgentSession {
  const session = harness.createSession(provider, { interactive: true })
  if (!session.setMode("plan")) throw new Error("could not enter plan mode")
  return session
}

function answerReview(session: AgentSession, observed: AgentEvent[], choose: (labels: string[]) => string): () => void {
  return session.subscribe((event) => {
    observed.push(event)
    if (event.type !== "elicitation_requested") return
    const question = event.questions[0]
    if (!question) throw new Error("plan review asked nothing")
    session.answerElicitation(event.requestId, [
      { questionId: question.id, value: choose(question.options.map((option) => option.label)) },
    ])
  })
}

function turnsSettled(session: AgentSession, turns: number): Promise<void> {
  return new Promise((resolve) => {
    let ended = 0
    const unsubscribe = session.subscribe((event) => {
      if (event.type !== "turn_ended") return
      ended += 1
      if (ended < turns) return
      unsubscribe()
      resolve()
    })
  })
}

test("restarts the session with the approved plan when the reviewer clears context", async () => {
  registerTool(submitPlanTool)
  const provider = planningProvider()
  const session = reviewSession(provider)
  const planningId = session.id
  const observed: AgentEvent[] = []
  const unsubscribe = answerReview(session, observed, (labels) => labels[1] ?? "")
  const settled = turnsSettled(session, 2)

  try {
    expect(session.send({ text: "Plan the widget", images: [] })).toBe(true)
    await settled

    const request = observed.find((event) => event.type === "elicitation_requested")
    expect(request?.type === "elicitation_requested" ? request.questions[0]?.options : undefined).toEqual([
      {
        label: "Approve and build",
        description: "Restore the previous writable mode, or normal mode, and begin implementing.",
      },
      {
        label: "Clear context and build",
        description: "Start a new session that carries only this plan. Context: 45% used.",
      },
      { label: "Request changes", description: "Keep plan mode active so the proposal can be revised." },
    ])

    expect(session.id).not.toBe(planningId)
    expect(session.currentMode).toBe("normal")
    expect(session.currentPlan).toBeUndefined()
    expect(provider.requests).toHaveLength(2)
    expect(provider.requests[1]?.input).toEqual([
      { type: "user_message", text: `${RESTART_PROMPT}\n\n${PLAN}`, images: [] },
    ])
  } finally {
    unsubscribe()
    unregisterTool(submitPlanTool)
  }
})

test("keeps building in the same session when the reviewer approves without clearing", async () => {
  registerTool(submitPlanTool)
  const provider = planningProvider()
  const session = reviewSession(provider)
  const planningId = session.id
  const observed: AgentEvent[] = []
  const unsubscribe = answerReview(session, observed, (labels) => labels[0] ?? "")
  const settled = turnsSettled(session, 1)

  try {
    expect(session.send({ text: "Plan the widget", images: [] })).toBe(true)
    await settled

    expect(session.id).toBe(planningId)
    expect(session.currentMode).toBe("normal")
    expect(session.currentPlan?.status).toBe("approved")
    expect(provider.requests).toHaveLength(2)
    expect(provider.requests[1]?.input.at(0)).toEqual({ type: "user_message", text: "Plan the widget", images: [] })
  } finally {
    unsubscribe()
    unregisterTool(submitPlanTool)
  }
})
