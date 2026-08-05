import type { AppEvent, PluginFailure } from "../../../events"
import type { Screen } from "../screen"

export class InputQueue {
  private ready = false
  private pending: string | undefined

  constructor(private readonly send: (text: string) => boolean) {}

  submit(text: string): boolean {
    if (this.ready) return this.send(text)
    this.pending = text
    return true
  }

  release(): void {
    this.ready = true
    if (this.pending === undefined) return
    this.send(this.pending)
    this.pending = undefined
  }
}

function failureDetails(failures: PluginFailure[]): string[] {
  return failures.map((failure) => `${failure.plugin}: ${failure.reason}`)
}

export class AppEventController {
  constructor(
    private readonly screen: Screen,
    private readonly input: InputQueue,
  ) {}

  handle(event: AppEvent): void {
    const { scrollback, statusBar, composer } = this.screen

    switch (event.type) {
      case "plugin_registration_finished": {
        const { total, failures } = event.status
        const registered = total - failures.length
        if (failures.length === 0) {
          scrollback.append({ kind: "info", text: `plugins: ${registered}/${total} registered` })
          break
        }
        scrollback.append({
          kind: "notice",
          summary: `plugins: ${registered}/${total} registered — ctrl+o to see failures`,
          details: failureDetails(failures),
        })
        break
      }
      case "plugin_bootstrap_started":
        statusBar.setLoading("Bootstrapping plugins")
        break
      case "plugin_bootstrap_finished": {
        statusBar.setLoading(undefined)
        const failures = event.status.failures.filter((failure) => failure.phase === "bootstrap")
        if (failures.length > 0) {
          scrollback.append({
            kind: "notice",
            summary: `plugins: ${failures.length} failed to initialize — ctrl+o to see failures`,
            details: failureDetails(failures),
          })
        }
        this.input.release()
        composer.focus()
        break
      }
    }
  }
}
