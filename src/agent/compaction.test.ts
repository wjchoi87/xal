import { expect, test } from "bun:test"
import type { ConversationItem } from "../providers/types"
import { round, ScriptedProvider } from "./agent-session-test-support"
import type { HistoryItem } from "./history"
import { activeHistory, summaryMessage } from "./history"
import { estimateHistoryTokens, splitForCompaction, summarizeHistory } from "./compaction"

test("keeps a tool round whole when the tail budget lands inside it", () => {
  const final: ConversationItem = { type: "assistant_message", text: "Finished" }
  const items: HistoryItem[] = [
    { type: "user_message", text: "Inspect", images: [] },
    { type: "assistant_message", text: "Checking" },
    { type: "tool_call", callId: "call-1", name: "read", args: {} },
    { type: "tool_result", callId: "call-1", output: "done" },
    final,
  ]

  const split = splitForCompaction(items, 3)

  expect(split).toEqual({
    head: items.slice(0, 4),
    tail: [final],
    replaced: 4,
  })
})

test("counts and splits only content after the last compaction floor", () => {
  const previous: HistoryItem = {
    type: "compaction",
    summary: "Earlier work",
    replaced: 6,
    retained: [{ type: "assistant_message", text: "Retained context" }],
  }
  const final: ConversationItem = { type: "assistant_message", text: "Complete" }
  const items: HistoryItem[] = [
    previous,
    { type: "user_message", text: "Continue", images: [] },
    { type: "assistant_message", text: "Working" },
    { type: "tool_call", callId: "call-2", name: "read", args: {} },
    { type: "tool_result", callId: "call-2", output: "done" },
    final,
  ]

  expect(splitForCompaction(items, 2)).toEqual({
    head: items.slice(0, 5),
    tail: [final],
    replaced: 4,
  })
  expect(splitForCompaction(items, estimateHistoryTokens(items.slice(1)))).toEqual({
    head: [],
    tail: [],
    replaced: 0,
  })
})

test("active history replaces pre-compaction content with the summary and retained tail", () => {
  const retained: ConversationItem[] = [
    { type: "user_message", text: "Retained prompt", images: [] },
    { type: "assistant_message", text: "Retained answer" },
  ]
  const later: ConversationItem = { type: "user_message", text: "Later prompt", images: [] }
  const items: HistoryItem[] = [
    { type: "user_message", text: "Discarded prompt", images: [] },
    { type: "assistant_message", text: "Discarded answer" },
    { type: "compaction", summary: "Authoritative summary", replaced: 2, retained },
    later,
  ]

  expect(activeHistory(items)).toEqual([summaryMessage("Authoritative summary"), ...retained, later])
})

test("summarizes the active history with the dedicated request contract", async () => {
  const provider = new ScriptedProvider([
    round([
      { type: "text_delta", text: "streamed draft" },
      { type: "item_done", item: { type: "assistant_message", text: "  settled summary  " } },
      { type: "done" },
    ]),
  ])
  const history: HistoryItem[] = [
    {
      type: "user_message",
      messageId: "11111111-1111-4111-8111-111111111111",
      text: "Original prompt",
      images: [],
    },
    { type: "assistant_message", text: "Original answer" },
  ]

  const summary = await summarizeHistory({
    provider,
    model: "test-model",
    thinking: "high",
    sessionId: "summary-session",
    history,
    instructions: "the unfinished migration",
    signal: new AbortController().signal,
  })

  expect(summary).toBe("settled summary")
  expect(provider.requests).toHaveLength(1)
  expect(provider.requests[0]).toMatchObject({
    model: "test-model",
    thinking: "high",
    sessionId: "summary-session",
    tools: [],
    input: [
      { type: "user_message", text: "Original prompt", images: [] },
      { type: "assistant_message", text: "Original answer" },
      {
        type: "user_message",
        text: "Summarize the conversation above so that work can continue after the earlier messages are dropped.\n\nFocus the summary on: the unfinished migration",
        images: [],
      },
    ],
  })
  expect(provider.requests[0]?.instructions).toContain("Preserve exact identifiers")
})

test("falls back to streamed summary text and rejects an empty summary", async () => {
  const streamed = new ScriptedProvider([
    round([{ type: "text_delta", text: "  streamed summary  " }, { type: "done" }]),
  ])
  expect(
    await summarizeHistory({
      provider: streamed,
      model: "test-model",
      thinking: undefined,
      sessionId: "streamed-summary",
      history: [{ type: "user_message", text: "Prompt", images: [] }],
      instructions: undefined,
      signal: new AbortController().signal,
    }),
  ).toBe("streamed summary")

  const empty = new ScriptedProvider([round([{ type: "done" }])])
  await expect(
    summarizeHistory({
      provider: empty,
      model: "test-model",
      thinking: undefined,
      sessionId: "empty-summary",
      history: [{ type: "user_message", text: "Prompt", images: [] }],
      instructions: undefined,
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow("Scripted provider returned an empty summary")
})
