import { playBoot } from "./boot.ts"
import { commands, findCommand, type Command, type CommandContext } from "./content/commands.ts"
import * as content from "./content/sections.ts"
import { setNavigationPath } from "./navigation.ts"
import type { Block } from "./tui/blocks.ts"
import { Composer } from "./tui/composer.ts"
import { delay, el, reducedMotion } from "./tui/dom.ts"
import { approvalFor, Permission, type PermissionChoice } from "./tui/permission.ts"
import { Scrollback } from "./tui/scrollback.ts"
import { StatusBar } from "./tui/status-bar.ts"

const PALETTE_HINT = "↑↓ · Tab · Enter · Esc"

export async function startApp(root: HTMLElement): Promise<void> {
  const blockDelay = reducedMotion() ? 0 : 90
  const prerendered = root.querySelector(".stream")
  const scrollback = new Scrollback(prerendered instanceof HTMLElement ? prerendered : undefined)
  const statusBar = new StatusBar(content.MODEL, content.THINKING)
  const permission = new Permission()
  const composer = new Composer(
    commands.map((command) => ({ name: command.name, description: command.describe })),
    (value) => void submit(value),
    (open) => statusBar.setHint(open ? PALETTE_HINT : undefined),
  )

  const footer = el("div", "footer")
  footer.append(composer.view)
  footer.append(statusBar.view)
  if (!prerendered) root.append(scrollback.view)
  root.append(footer)

  let busy = false
  let waiting = 0
  let unattended = false

  async function print(...blocks: Block[]): Promise<void> {
    for (const block of blocks) {
      scrollback.append(block)
      statusBar.addTokens(320 + Math.round(JSON.stringify(block).length / 3))
      if (blockDelay) await delay(blockDelay)
    }
  }

  function ask(choices: PermissionChoice[]): Promise<PermissionChoice> {
    if (unattended) return Promise.resolve(approvalFor(choices))
    composer.setEnabled(false)
    statusBar.setActivity({ kind: "approval" })
    const started = performance.now()
    const answer = permission.ask(choices)
    scrollback.attach(permission.view)
    return answer.then((choice) => {
      waiting += performance.now() - started
      permission.view.remove()
      composer.setEnabled(true)
      statusBar.setActivity({ kind: "working" })
      return choice
    })
  }

  const context: CommandContext = {
    print,
    replaceLast: (block) => scrollback.replaceLast(block),
    reset: () => {
      scrollback.reset()
      statusBar.resetTokens()
    },
    ask,
    open: (url) => window.open(url, "_blank", "noreferrer"),
    visit: (url) => location.assign(url),
  }

  function navigate(command: Command): void {
    const path = command.routable ? command.name : command.name === "/clear" ? "/" : undefined
    if (path && location.pathname !== path) history.pushState(null, "", path)
    setNavigationPath(location.pathname)
  }

  function routedCommand(): Command | undefined {
    const path = location.pathname.replace(/\/+$/, "")
    return path ? findCommand(path) : undefined
  }

  async function submit(value: string, options: { routed?: boolean } = {}): Promise<void> {
    if (busy) return
    scrollback.setAutoScroll(options.routed !== true)
    const at = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    scrollback.append({ kind: "user", text: value, at })

    const command = findCommand(value)
    if (!command) {
      await print({ kind: "info", text: `unknown command \`${value}\` — try \`/help\`` })
      scrollback.setAutoScroll(false)
      return
    }
    if (!options.routed) navigate(command)

    busy = true
    waiting = 0
    unattended = options.routed === true
    statusBar.setActivity({ kind: "working" })
    const started = performance.now()
    if (blockDelay) await delay(260)
    const [, ...rest] = value.trim().split(/\s+/)
    await command.run(context, rest.join(" "))
    const elapsed = `${((performance.now() - started - waiting) / 1000).toFixed(1)}s`
    statusBar.setActivity({ kind: "finished", elapsed })
    unattended = false
    busy = false
    scrollback.setAutoScroll(false)
  }

  window.addEventListener("popstate", () => {
    setNavigationPath(location.pathname)
    const command = routedCommand()
    if (command) void submit(command.name, { routed: true })
  })

  window.addEventListener("keydown", (event) => {
    if (permission.handleKey(event)) return
    if (event.metaKey || event.ctrlKey || event.altKey) return
    if (document.activeElement === composer.input) return
    if (event.key.length === 1) composer.focus()
  })

  document.addEventListener("mouseup", () => {
    if (permission.open) return
    if (window.getSelection()?.toString()) return
    composer.focus()
  })

  const landed = routedCommand()

  if (!landed) await playBoot(document.body)

  if (!prerendered) {
    await print(...(landed ? [content.banner] : content.landing))
    if (landed) await submit(landed.name, { routed: true })
  }

  composer.focus()
}
