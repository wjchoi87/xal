import { settings } from "../config/settings"
import { loadCredentialSecrets } from "../config/credentials"
import { resolveThinking } from "../config/thinking"
import { pathExists } from "../lib/fs"
import type { PermissionMode } from "../permissions/types"
import { findModel } from "../providers/catalog"
import { getProvider, listProviders } from "../providers/registry"
import type { Provider, ThinkingEffort } from "../providers/types"
import { loadSession } from "../sessions/store"
import type { LoadedSession, SessionSummary } from "../sessions/types"
import { AgentSession } from "./agent-session"
import type { OutputSchema } from "./output-contract"

export interface SessionSetup {
  session: AgentSession
  model: string
}

export interface SessionOptions {
  provider?: string
  model?: string
  persist?: boolean
  interactive?: boolean
  outputSchema?: OutputSchema
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
  await loadCredentialSecrets()
  const provider = resolveProvider(options.provider)
  const model =
    options.model ?? (options.provider === undefined ? settings().model : undefined) ?? (await provider.defaultModel())
  const thinking = await resolveThinking(provider, model)
  const modelInfo = await findModel(provider, model)
  return {
    session: new AgentSession({
      provider,
      model,
      modelInputModalities: modelInfo?.inputModalities,
      thinking,
      persist: options.persist,
      interactive: options.interactive,
      outputSchema: options.outputSchema,
    }),
    model,
  }
}

function lastState(loaded: LoadedSession): {
  cwd: string
  provider: string
  model: string
  thinking?: ThinkingEffort
  mode: PermissionMode
} {
  const state = {
    cwd: loaded.meta.cwd,
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
      case "workspace_changed":
        state.cwd = event.cwd
        break
      case "mode_changed":
        state.mode = event.mode
        break
      case "plan_updated":
      case "session_started":
      case "session_title_changed":
      case "state_changed":
      case "user_message":
      case "conversation_rewound":
      case "conversation_redone":
      case "tool_call_updated":
      case "hook_started":
      case "hook_finished":
      case "queue_changed":
      case "queue_flushed":
      case "text_delta":
      case "reasoning_summary_delta":
      case "reasoning_delta":
      case "assistant_message":
      case "reasoning_summary":
      case "retry_scheduled":
      case "approval_requested":
      case "elicitation_requested":
      case "elicitation_resolved":
      case "tool_started":
      case "tool_updated":
      case "tool_finished":
      case "task_list_updated":
      case "compacted":
      case "turn_ended":
      case "turn_failed":
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
  const modelInfo = await findModel(provider, model)
  let cwd = last.cwd
  if (!(await pathExists(cwd))) {
    const fallback = (await pathExists(loaded.meta.cwd)) ? loaded.meta.cwd : process.cwd()
    notices.push(`recorded workspace ${cwd} is unavailable — continuing in ${fallback}`)
    cwd = fallback
  }
  if (!recorded) {
    notices.push(`provider ${last.provider} is not available — continuing with ${provider.id} · ${model}`)
  }
  if (cwd !== process.cwd()) {
    notices.push(`this session was working in ${cwd} — paths may not match ${process.cwd()}`)
  }

  if (
    !session.resume({
      session: loaded,
      path: summary.path,
      cwd,
      provider,
      model,
      modelInputModalities: modelInfo?.inputModalities,
      thinking,
      mode: last.mode,
    })
  ) {
    throw new Error("cannot resume while a turn is running")
  }
  return notices
}
