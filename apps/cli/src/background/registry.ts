import type { Usage } from "../providers/types"

export type BackgroundTaskState = { running: true } | { running: false; ok: boolean; detail: string }

interface BackgroundTaskBase {
  id: string
  title: string
  startedAt: number
  cwd: string
  state(): BackgroundTaskState
  output(): string
  stop(): Promise<void>
}

export interface BackgroundProcessTask extends BackgroundTaskBase {
  kind: "process"
}

export interface BackgroundAgentSnapshot {
  activity: string
  elapsedMs: number
  toolCount: number
  usage?: Usage
}

export interface BackgroundAgentTask extends BackgroundTaskBase {
  kind: "agent"
  role: string
  model: string
  snapshot(): BackgroundAgentSnapshot
}

export type BackgroundTask = BackgroundProcessTask | BackgroundAgentTask

const tasks = new Map<string, BackgroundTask>()
const listeners = new Set<() => void>()

export function registerBackgroundTask(task: BackgroundTask): void {
  tasks.set(task.id, task)
  backgroundTasksChanged()
}

export function removeBackgroundTask(id: string): void {
  if (tasks.delete(id)) backgroundTasksChanged()
}

export function listBackgroundTasks(): BackgroundTask[] {
  return [...tasks.values()]
}

export function backgroundTasksChanged(): void {
  for (const listener of listeners) listener()
}

export function subscribeBackgroundTasks(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
