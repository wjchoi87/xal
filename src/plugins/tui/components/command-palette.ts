import { StyledText, type BoxRenderable, type RenderContext, type TextRenderable } from "@opentui/core"
import { listCommands } from "../../../commands/registry"
import type { Command } from "../../../commands/types"
import { column, label, row } from "../lib/renderables"
import { COLORS } from "../theme/colors"
import { background, border, muted, paint } from "../theme/styles"

export const PALETTE_CHROME_ROWS = 3

const MAX_ROWS = 6
const NAME_WIDTH = 22

export interface CommandPaletteActions {
  complete(line: string): void
  run(line: string): void
}

function entriesFor(value: string): Command[] {
  const query = value.slice(1)
  if (/\s/.test(query)) return []
  const needle = query.toLowerCase()
  return listCommands().filter((command) => !command.hidden && command.name.toLowerCase().includes(needle))
}

export class CommandPalette {
  readonly view: BoxRenderable
  private readonly options: BoxRenderable
  private readonly rows: TextRenderable[] = []
  private entries: Command[] = []
  private selected = 0
  private offset = 0
  private limit = MAX_ROWS

  get visible(): boolean {
    return this.view.visible
  }

  get height(): number {
    return this.rowCount + PALETTE_CHROME_ROWS
  }

  private get rowCount(): number {
    return Math.min(this.entries.length, this.limit)
  }

  constructor(
    ctx: RenderContext,
    private readonly actions: CommandPaletteActions,
    private readonly onChange: () => void,
  ) {
    this.view = row(ctx, {
      visible: false,
      border: true,
      borderStyle: "rounded",
      paddingLeft: 1,
      paddingRight: 1,
      marginLeft: 1,
      marginRight: 1,
      marginTop: 1,
      ...background(),
      ...border(COLORS.accent),
    })
    this.options = column(ctx, { flexGrow: 1, flexShrink: 1, minWidth: 1 })

    this.view.add(this.options)
    this.view.add(label(ctx, { content: "↑↓ · Tab · Enter · Esc", flexShrink: 0, marginLeft: 1, color: COLORS.faint }))

    for (let index = 0; index < MAX_ROWS; index++) {
      const line = label(ctx, { content: "" })
      this.rows.push(line)
      this.options.add(line)
    }
  }

  update(value: string, limit: number): void {
    if (!value.startsWith("/")) {
      this.hide()
      return
    }
    const entries = entriesFor(value)
    if (entries.length === 0) {
      this.hide()
      return
    }
    const previous = this.view.visible ? this.rowCount : 0
    this.limit = Math.max(1, Math.min(MAX_ROWS, limit))
    this.entries = entries
    this.selected = 0
    this.offset = 0
    this.renderOptions()
    this.view.height = this.rowCount + 2
    this.view.visible = true
    if (this.rowCount !== previous) this.onChange()
  }

  hide(): void {
    if (!this.view.visible) return
    this.view.visible = false
    this.onChange()
  }

  handleKey(name: string): boolean {
    if (!this.view.visible) return false
    if (name === "up") {
      this.move(-1)
      return true
    }
    if (name === "down") {
      this.move(1)
      return true
    }
    if (name === "escape") {
      this.hide()
      return true
    }
    if (name === "tab") {
      this.complete(this.entries[this.selected])
      return true
    }
    if (name === "return" || name === "enter") {
      this.confirm(this.entries[this.selected])
      return true
    }
    return false
  }

  private move(delta: number): void {
    const count = this.entries.length
    this.selected = (this.selected + delta + count) % count
    if (this.selected < this.offset) this.offset = this.selected
    if (this.selected >= this.offset + this.rowCount) this.offset = this.selected - this.rowCount + 1
    this.renderOptions()
  }

  private complete(entry: Command | undefined): void {
    if (!entry) return
    this.actions.complete(`/${entry.name} `)
  }

  private confirm(entry: Command | undefined): void {
    if (!entry) return
    this.hide()
    this.actions.run(`/${entry.name}`)
  }

  private renderOptions(): void {
    this.rows.forEach((line, index) => {
      const entry = index < this.rowCount ? this.entries[this.offset + index] : undefined
      if (!entry) {
        line.content = new StyledText([muted("")])
        line.visible = false
        return
      }
      line.visible = true
      const text = `/${entry.name}`.padEnd(NAME_WIDTH) + entry.describe
      const position = this.offset + index
      line.content = new StyledText([
        position === this.selected ? paint(COLORS.accent, `❯ ${text}`) : muted(`  ${text}`),
      ])
    })
  }
}
