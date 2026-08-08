import type { AppEvent, EventService } from "./types"

class AppEventService implements EventService {
  private readonly listeners = new Set<(event: AppEvent) => void>()
  private readonly retained = new Map<AppEvent["type"], AppEvent>()

  private notify(listener: (event: AppEvent) => void, event: AppEvent): void {
    try {
      listener(event)
    } catch (error) {
      console.error(`event listener failed for ${event.type}:`, error)
    }
  }

  emitRetained(event: AppEvent): void {
    this.retained.set(event.type, event)
    for (const listener of this.listeners) this.notify(listener, event)
  }

  subscribe(listener: (event: AppEvent) => void, replayRetained = false): () => void {
    this.listeners.add(listener)
    if (replayRetained) {
      for (const event of this.retained.values()) this.notify(listener, event)
    }
    return () => this.listeners.delete(listener)
  }
}

export const events: EventService = new AppEventService()
export type { AppEvent, EventService, PluginFailure, PluginStatus } from "./types"
