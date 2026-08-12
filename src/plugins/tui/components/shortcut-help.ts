import { StyledText, type BoxRenderable, type RenderContext, type TextRenderable } from "@opentui/core"
import { label, row } from "../lib/renderables"
import { COLORS } from "../theme/colors"
import { muted, paint } from "../theme/styles"

const WIDE = 80
const KEY_WIDTH = 18
const SHORTCUTS = [
  { key: "/", description: "commands" },
  { key: "$", description: "skills" },
  { key: "Shift+Enter", description: "new line" },
  { key: "Tab", description: "complete selection" },
  { key: "Ctrl+G", description: "external editor" },
  { key: "Ctrl+V", description: "paste image" },
  { key: "Ctrl+U", description: "clear input" },
  { key: "Esc Esc / Ctrl+R", description: "jump history" },
  { key: "↑ / ↓", description: "browse history" },
  { key: "Shift+Tab", description: "change mode" },
  { key: "Ctrl+O", description: "toggle details" },
  { key: "Ctrl+T", description: "toggle todos" },
  { key: "Ctrl+C", description: "clear / interrupt / quit" },
]

function shortcut(key: string, description: string): StyledText {
  return new StyledText([paint(COLORS.accent, key.padEnd(KEY_WIDTH)), muted(description)])
}

export class ShortcutHelp {
  readonly view: BoxRenderable
  private readonly entries: TextRenderable[] = []
  private active = false
  private covered = false
  private wide: boolean

  constructor(
    private readonly ctx: RenderContext,
    onResize: () => void,
  ) {
    this.wide = ctx.width >= WIDE
    this.view = row(ctx, {
      visible: false,
      flexWrap: "wrap",
      height: this.rows,
      paddingLeft: 2,
      paddingRight: 2,
    })
    for (const entry of SHORTCUTS) {
      const item = label(ctx, {
        content: shortcut(entry.key, entry.description),
        width: this.itemWidth,
        minWidth: 0,
      })
      this.entries.push(item)
      this.view.add(item)
    }
    this.view.onSizeChange = () => {
      if (!this.syncLayout() || !this.view.visible) return
      onResize()
    }
  }

  get height(): number {
    return this.view.visible ? this.rows : 0
  }

  setActive(active: boolean): boolean {
    if (this.active === active) return false
    this.active = active
    if (active) this.syncLayout()
    return this.syncVisibility()
  }

  setCovered(covered: boolean): boolean {
    if (this.covered === covered) return false
    this.covered = covered
    return this.syncVisibility()
  }

  private get rows(): number {
    return this.wide ? Math.ceil(SHORTCUTS.length / 2) : SHORTCUTS.length
  }

  private get itemWidth(): "50%" | "100%" {
    return this.wide ? "50%" : "100%"
  }

  private syncLayout(): boolean {
    const wide = this.ctx.width >= WIDE
    if (this.wide === wide) return false
    this.wide = wide
    this.view.height = this.rows
    for (const entry of this.entries) entry.width = this.itemWidth
    return true
  }

  private syncVisibility(): boolean {
    const visible = this.active && !this.covered
    if (this.view.visible === visible) return false
    this.view.visible = visible
    return true
  }
}
