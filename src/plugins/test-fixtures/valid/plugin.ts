import { isRecord } from "../../../lib/json"
import type { PluginContext } from "../../types"

interface LifecycleState {
  phases: string[]
  bound: boolean[]
  contexts: PluginContext[]
}

const identity = {}

export const lifecycleState: LifecycleState = {
  phases: [],
  bound: [],
  contexts: [],
}

export function resetLifecycleState(): void {
  lifecycleState.phases.length = 0
  lifecycleState.bound.length = 0
  lifecycleState.contexts.length = 0
}

function record(phase: string, receiver: unknown, ctx: PluginContext): void {
  lifecycleState.phases.push(phase)
  lifecycleState.bound.push(isRecord(receiver) && receiver.identity === identity)
  lifecycleState.contexts.push(ctx)
}

export default {
  identity,
  name: "valid-fixture",
  register(this: unknown, ctx: PluginContext) {
    record("register", this, ctx)
  },
  async bootstrap(this: unknown, ctx: PluginContext) {
    await Promise.resolve()
    record("bootstrap", this, ctx)
  },
  async shutdown(this: unknown, ctx: PluginContext) {
    await Promise.resolve()
    record("shutdown", this, ctx)
  },
}
