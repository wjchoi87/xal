import type { ConversationItem } from "../providers/types"

export class Session {
  readonly id = crypto.randomUUID()
  readonly items: ConversationItem[] = []

  addUserMessage(text: string): void {
    this.items.push({ role: "user", content: [{ type: "input_text", text }] })
  }

  addToolOutput(callId: string, output: string): void {
    this.items.push({ type: "function_call_output", call_id: callId, output })
  }

  addItems(items: ConversationItem[]): void {
    this.items.push(...items)
  }
}
