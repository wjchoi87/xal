import { ProviderError } from "../../providers/errors"
import { sseEvents, streamError } from "../../providers/transport"
import type { StreamEvent } from "../../providers/types"
import { parseOutputItem, parseSseEvent } from "./wire"

interface ResponseStreamOptions {
  providerId: string
  providerName: string
  model: string
  signal?: AbortSignal
}

export async function* responseEvents(response: Response, options: ResponseStreamOptions): AsyncGenerator<StreamEvent> {
  if (!response.body) throw new ProviderError(`${options.providerName} response had no body`, { retryable: true })

  let terminal = false
  try {
    for await (const raw of sseEvents(response.body)) {
      if (raw.done) continue
      const event = parseSseEvent(raw.data)
      if (!event) continue
      switch (event.type) {
        case "output_text_delta":
          yield { type: "text_delta", text: event.delta }
          break
        case "reasoning_summary_delta":
          yield { type: "reasoning_summary_delta", text: event.delta }
          break
        case "reasoning_delta":
          yield { type: "reasoning_delta", text: event.delta }
          break
        case "item_done": {
          const item = parseOutputItem(
            event.item,
            { provider: options.providerId, model: options.model },
            options.providerName,
          )
          if (item) yield { type: "item_done", item }
          break
        }
        case "terminal":
          terminal = true
          yield { type: "done", usage: event.usage }
          break
        case "failure":
          throw new ProviderError(event.message, { retryable: event.retryable })
      }
      if (terminal) break
    }
  } catch (error) {
    streamError(options.providerName, error, options.signal)
  }
  if (!terminal) throw new ProviderError(`${options.providerName} stream ended unexpectedly`, { retryable: true })
}
