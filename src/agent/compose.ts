import { settings } from "../config/settings"
import type { PermissionMode } from "../permissions/types"
import { getProvider, listProviders } from "../providers/registry"
import type { Provider } from "../providers/types"
import { loadSession } from "../sessions/store"
import type { LoadedSession, SessionSummary } from "../sessions/types"
import { AgentSession } from "./agent-session"

export interface SessionSetup {
  session: AgentSession
  provider: Provider
  model: string
}

export interface SessionOptions {
  provider?: string
  model?: string
  persist?: boolean
}

export function resolveProvider(id?: string): Provider {
  const wanted = id ?? settings().provider
  if (wanted) {
    const provider = getProvider(wanted)
    if (!provider) throw new Error(`unknown provider: ${wanted}`)
    return provider
  }
  const provider = listProviders().at(-1)
  if (!provider) throw new Error("no provider registered")
  return provider
}

export async function createSession(options: SessionOptions = {}): Promise<SessionSetup> {
  const provider = resolveProvider(options.provider)
  const model = options.model ?? settings().model ?? (await provider.defaultModel())
  return { session: new AgentSession({ provider, model, persist: options.persist }), provider, model }
}

function lastState(loaded: LoadedSession): { provider: string; model: string; mode: PermissionMode } {
  const state = { provider: loaded.meta.provider, model: loaded.meta.model, mode: loaded.meta.mode }
  for (const event of loaded.events) {
    if (event.type === "model_changed") {
      state.provider = event.provider
      state.model = event.model
    }
    if (event.type === "mode_changed") state.mode = event.mode
  }
  return state
}

export async function resumeSession(session: AgentSession, summary: SessionSummary): Promise<string[]> {
  const loaded = await loadSession(summary.path)
  if (!loaded) throw new Error(`session is unreadable: ${summary.path}`)

  const notices: string[] = []
  const last = lastState(loaded)
  const recorded = getProvider(last.provider)
  const provider = recorded ?? session.currentProvider
  const model = recorded ? last.model : session.currentModel
  if (!recorded) {
    notices.push(`provider ${last.provider} is not available — continuing with ${provider.id} · ${model}`)
  }
  if (loaded.meta.cwd !== process.cwd()) {
    notices.push(`this session was recorded in ${loaded.meta.cwd} — paths may not match ${process.cwd()}`)
  }

  if (!session.resume({ session: loaded, path: summary.path, provider, model, mode: last.mode })) {
    throw new Error("cannot resume while a turn is running")
  }
  return notices
}
