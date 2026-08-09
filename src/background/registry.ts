export type BackgroundTaskState = { running: true } | { running: false; ok: boolean; detail: string }

export interface BackgroundTask {
  id: string
  title: string
  startedAt: number
  state(): BackgroundTaskState
  output(): string
  stop(): Promise<void>
}

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
