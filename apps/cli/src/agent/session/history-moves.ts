import { describeError } from "../../lib/error"
import type { AppliedCodeRedo, CodeRewind, WorkspaceUndo } from "../../tools/undo"
import type { AgentEvent } from "../events"
import { rewindConversation, type ConversationCheckpoint, type ConversationState } from "../history"
import type { RedoEntry, RedoOutcome, UndoOutcome } from "./types"

export class RedoStack {
  private entries: RedoEntry[] = []
  private invalidated: string | undefined

  get message(): string | undefined {
    return this.invalidated
  }

  peek(): RedoEntry | undefined {
    return this.entries.at(-1)
  }

  push(entries: RedoEntry[]): void {
    this.invalidated = undefined
    this.entries.push(...entries)
  }

  pop(): void {
    this.entries.pop()
    this.invalidated = undefined
  }

  invalidate(reason: string): void {
    if (this.entries.length === 0) return
    this.entries = []
    this.invalidated = reason
  }

  reset(): void {
    this.entries = []
    this.invalidated = undefined
  }
}

export interface HistoryMoveHost {
  readonly redoStack: RedoStack
  workspaceUndo(): WorkspaceUndo
  conversation(): ConversationState
  restoreConversation(state: ConversationState): void
  recordEvent(event: AgentEvent): Promise<AgentEvent>
  notify(event: AgentEvent): void
}

export async function performUndo(host: HistoryMoveHost, checkpoint: ConversationCheckpoint): Promise<UndoOutcome> {
  let codeRewind: CodeRewind
  try {
    codeRewind = await host.workspaceUndo().rewind(checkpoint.messageId)
  } catch (error) {
    return { status: "stopped", message: describeError(error) }
  }

  const rewound = rewindConversation(host.conversation(), checkpoint.messageId)
  if (!rewound) {
    try {
      await codeRewind.rollback()
    } catch (error) {
      return {
        status: "stopped",
        message: `the checkpoint changed and code rollback failed: ${describeError(error)}`,
      }
    }
    return { status: "invalid" }
  }
  if (codeRewind.steps !== rewound.redos.length) {
    try {
      await codeRewind.rollback()
    } catch (error) {
      return {
        status: "stopped",
        message: `conversation and code history disagree; code rollback also failed: ${describeError(error)}`,
      }
    }
    return { status: "stopped", message: "conversation and code history disagree" }
  }

  const fileCount = codeRewind.count
  let recorded: AgentEvent
  try {
    recorded = await host.recordEvent({
      type: "conversation_rewound",
      messageId: checkpoint.messageId,
      prompt: checkpoint.input.text,
      removedMessages: rewound.removedMessages,
      fileCount,
    })
  } catch (error) {
    try {
      await codeRewind.rollback()
    } catch (rollbackError) {
      return {
        status: "stopped",
        message: `the conversation could not be saved: ${describeError(error)}; code rollback also failed: ${describeError(rollbackError)}`,
      }
    }
    return { status: "stopped", message: `the conversation could not be saved: ${describeError(error)}` }
  }

  const codeRedos = codeRewind.commit()
  host.restoreConversation(rewound.active)
  const branch = host.workspaceUndo().branch
  host.redoStack.push(
    rewound.redos
      .map((conversation, index): RedoEntry => {
        const code = codeRedos[index]
        if (!code) throw new Error("conversation and code redo history disagree")
        return {
          messageId: conversation.messageId,
          prompt: conversation.prompt,
          conversation: conversation.state,
          code,
          fileCount: code.count,
          branch,
        }
      })
      .toReversed(),
  )
  host.notify(recorded)
  return {
    status: "undone",
    prompt: checkpoint.input.text,
    fileCount,
    input: rewound.input,
  }
}

export async function performRedo(host: HistoryMoveHost, entry: RedoEntry): Promise<RedoOutcome> {
  let applied: AppliedCodeRedo
  try {
    applied = await entry.code.apply()
  } catch (error) {
    return { status: "stopped", message: describeError(error) }
  }

  const restoredMessages = entry.conversation.checkpoints.length - host.conversation().checkpoints.length
  if (restoredMessages < 1) {
    try {
      await applied.rollback()
    } catch (error) {
      return {
        status: "stopped",
        message: `the superseded conversation is unavailable; code rollback also failed: ${describeError(error)}`,
      }
    }
    return { status: "stopped", message: "the superseded conversation is unavailable" }
  }

  let recorded: AgentEvent
  try {
    recorded = await host.recordEvent({
      type: "conversation_redone",
      messageId: entry.messageId,
      prompt: entry.prompt,
      restoredMessages,
      fileCount: entry.fileCount,
    })
  } catch (error) {
    try {
      await applied.rollback()
    } catch (rollbackError) {
      return {
        status: "stopped",
        message: `the conversation could not be saved: ${describeError(error)}; code rollback also failed: ${describeError(rollbackError)}`,
      }
    }
    return { status: "stopped", message: `the conversation could not be saved: ${describeError(error)}` }
  }

  host.restoreConversation(entry.conversation)
  applied.commit()
  host.redoStack.pop()
  host.notify(recorded)
  return {
    status: "redone",
    prompt: entry.prompt,
    fileCount: entry.fileCount,
  }
}
