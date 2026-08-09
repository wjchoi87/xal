import { settings } from "../config/settings"
import { resolveThinking } from "../config/thinking"
import type { PermissionMode } from "../permissions/types"
import { getProvider, listProviders } from "../providers/registry"
import type { Provider, ThinkingEffort } from "../providers/types"
import { loadSession } from "../sessions/store"
import type { LoadedSession, SessionSummary } from "../sessions/types"
import { AgentSession } from "./agent-session"

export interface SessionSetup {
  session: AgentSession
  model: string
}

export interface SessionOptions {
  provider?: string
  model?: string
  persist?: boolean
}

function resolveProvider(id?: string): Provider {
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
  const thinking = await resolveThinking(provider, model)
  return {
    session: new AgentSession({ provider, model, thinking, persist: options.persist }),
    model,
  }
}

function lastState(loaded: LoadedSession): {
  provider: string
  model: string
  thinking?: ThinkingEffort
  mode: PermissionMode
} {
  const state = {
    provider: loaded.meta.provider,
    model: loaded.meta.model,
    thinking: loaded.meta.thinking,
    mode: loaded.meta.mode,
  }
  for (const event of loaded.events) {
    switch (event.type) {
      case "model_changed":
        state.provider = event.provider
        state.model = event.model
        break
      case "thinking_changed":
        state.thinking = event.thinking
        break
      case "mode_changed":
        state.mode = event.mode
        break
      case "session_started":
      case "state_changed":
      case "user_message":
      case "queue_changed":
      case "queue_flushed":
      case "text_delta":
      case "reasoning_summary_delta":
      case "reasoning_delta":
      case "assistant_message":
      case "reasoning_summary":
      case "retry_scheduled":
      case "approval_requested":
      case "tool_started":
      case "tool_updated":
      case "tool_finished":
      case "compacted":
      case "turn_ended":
      case "turn_interrupted":
      case "error":
        break
    }
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
  const thinking = await resolveThinking(provider, model, last.thinking)
  if (!recorded) {
    notices.push(`provider ${last.provider} is not available — continuing with ${provider.id} · ${model}`)
  }
  if (loaded.meta.cwd !== process.cwd()) {
    notices.push(`this session was recorded in ${loaded.meta.cwd} — paths may not match ${process.cwd()}`)
  }

  if (!session.resume({ session: loaded, path: summary.path, provider, model, thinking, mode: last.mode })) {
    throw new Error("cannot resume while a turn is running")
  }
  return notices
}
