export interface Ui {
  id: string
  start(): Promise<void>
}

const uis = new Map<string, Ui>()

export function registerUi(ui: Ui): void {
  uis.set(ui.id, ui)
}

export function getUi(id: string): Ui | undefined {
  return uis.get(id)
}
