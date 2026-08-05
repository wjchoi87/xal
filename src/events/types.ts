export interface PluginFailure {
  plugin: string
  phase: "register" | "bootstrap"
  reason: string
}

export interface PluginStatus {
  total: number
  failures: PluginFailure[]
}

export type AppEvent =
  | { type: "plugin_registration_finished"; status: PluginStatus }
  | { type: "plugin_bootstrap_started"; total: number }
  | { type: "plugin_bootstrap_finished"; status: PluginStatus }

export interface EventService {
  emit(event: AppEvent): void
  emitRetained(event: AppEvent): void
  subscribe(listener: (event: AppEvent) => void, replayRetained?: boolean): () => void
}
