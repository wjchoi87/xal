import {
  bold,
  StyledText,
  t,
  TextAttributes,
  type Renderable,
  type RenderContext,
  type TextRenderable,
} from "@opentui/core"
import type { DenialCause } from "../../../agent/events"
import { appInfo } from "../../../app-info"
import { parseBoundedToolOutput } from "../../../tools/output"
import { getToolRenderer } from "../../../ui/extension"
import { commandLabel, settledStatus, type ToolOutcome } from "../components/tool-status"
import { formatTimestamp, formatTokens } from "../lib/format"
import { renderInlineMarkdown } from "../lib/markdown"
import { column, detailPanel, label, paragraph, row } from "../lib/renderables"
import { MAX_OUTPUT_ROWS, renderToolOutput } from "../output/render"
import { summarizeToolOutput, toolOutputFailed } from "../output/summary"
import { COLORS } from "../theme/colors"
import { background, muted, paint } from "../theme/styles"
import type { BannerBlock, Block, CompactionBlock, NoticeBlock, StreamBlock, ToolBlock, UserBlock } from "./blocks"

const GUTTER = 2

interface StreamView {
  view: Renderable
  text: TextRenderable
}

export function streamContent(block: StreamBlock): StyledText | string {
  if (block.kind === "text") return block.text
  return renderInlineMarkdown(block.text, COLORS.faint, TextAttributes.ITALIC)
}

export function streamView(ctx: RenderContext, block: StreamBlock): StreamView {
  const text = paragraph(ctx, {
    content: streamContent(block),
    color: block.kind === "text" ? COLORS.foreground : COLORS.faint,
  })
  return { view: frame(ctx, text), text }
}

export function renderBlock(ctx: RenderContext, block: Block, expanded: boolean): Renderable {
  switch (block.kind) {
    case "banner":
      return frame(ctx, banner(ctx, block))
    case "user":
      return frame(ctx, bubble(ctx, block))
    case "info":
      return frame(ctx, paragraph(ctx, { content: block.text, attributes: TextAttributes.DIM }))
    case "error":
      return frame(ctx, paragraph(ctx, { content: `x ${block.text}`, color: COLORS.error }))
    case "notice":
      return frame(ctx, notice(ctx, block, expanded))
    case "compaction":
      return frame(ctx, compaction(ctx, block, expanded))
    case "text":
    case "reasoning":
      return streamView(ctx, block).view
    case "tool":
      return tool(ctx, block, expanded)
  }
}

function frame(ctx: RenderContext, child: Renderable, marginTop = 1): Renderable {
  const box = column(ctx, { marginTop, paddingLeft: GUTTER, paddingRight: GUTTER })
  box.add(child)
  return box
}

function banner(ctx: RenderContext, block: BannerBlock): Renderable {
  const box = column(ctx)
  box.add(label(ctx, { content: t`${bold(paint(COLORS.accent, appInfo.name))} ${muted(`v${appInfo.version}`)}` }))
  box.add(label(ctx, { content: block.model, color: COLORS.faint }))
  box.add(label(ctx, { content: block.cwd, color: COLORS.faint }))
  return box
}

function bubble(ctx: RenderContext, block: UserBlock): Renderable {
  const box = row(ctx, { alignItems: "flex-start", padding: 1, ...background(COLORS.dim) })
  const images = Array.from({ length: block.imageCount }, (_, index) => `[Image #${index + 1}]`).join(" ")
  box.add(
    paragraph(ctx, {
      content: [block.text, images].filter(Boolean).join("\n"),
      flexGrow: 1,
      background: COLORS.dim,
    }),
  )
  box.add(
    label(ctx, {
      content: formatTimestamp(block.sentAt),
      flexShrink: 0,
      marginLeft: 2,
      attributes: TextAttributes.DIM,
      background: COLORS.dim,
    }),
  )
  return box
}

function notice(ctx: RenderContext, block: NoticeBlock, expanded: boolean): Renderable {
  const box = column(ctx)
  box.add(paragraph(ctx, { content: block.summary, color: COLORS.warning }))
  if (!expanded) return box
  const body = detailPanel(ctx)
  for (const detail of block.details) body.add(paragraph(ctx, { content: detail, color: COLORS.error }))
  box.add(body)
  return box
}

function compaction(ctx: RenderContext, block: CompactionBlock, expanded: boolean): Renderable {
  const box = column(ctx)
  const before = block.tokensBefore === undefined ? "" : ` · was ${formatTokens(block.tokensBefore)} tokens`
  const hint = expanded ? "" : " · ctrl+o to read it"
  box.add(
    paragraph(ctx, {
      content: `context compacted · ${block.replaced} items summarized${before}${hint}`,
      color: COLORS.warning,
    }),
  )
  if (!expanded) return box
  const body = detailPanel(ctx)
  body.add(paragraph(ctx, { content: block.summary, color: COLORS.faint }))
  box.add(body)
  return box
}

const denialSummary: Record<DenialCause, string> = {
  user: "denied",
  policy: "blocked",
  plan: "plan mode",
}

function tool(ctx: RenderContext, block: ToolBlock, expanded: boolean): Renderable {
  const toolRenderer = getToolRenderer(block.tool)
  const bounded = parseBoundedToolOutput(block.output)
  const coreFailed = toolOutputFailed(block.output)
  const failed = coreFailed || (toolRenderer?.failed?.(block.output) ?? false)
  const outcome: ToolOutcome = block.denial ? "denied" : failed ? "failure" : "success"
  const summary = block.denial
    ? denialSummary[block.denial]
    : bounded
      ? summarizeToolOutput(block.output)
      : coreFailed
        ? "failed"
        : (toolRenderer?.summarize?.(block.output) ?? summarizeToolOutput(block.output))

  const box = column(ctx, { paddingLeft: GUTTER, paddingRight: GUTTER })
  const head = row(ctx, { height: 1, alignItems: "center" })
  head.add(label(ctx, { content: block.readOnly ? ">" : "*", width: 2, color: COLORS.faint }))
  head.add(label(ctx, { content: commandLabel(block.tool, block.title), flexGrow: 1, flexShrink: 1, minWidth: 1 }))
  head.add(
    label(ctx, {
      content: settledStatus(outcome, summary, block.elapsed, ctx.width),
      flexShrink: 0,
      marginLeft: 1,
    }),
  )
  box.add(head)

  if (!(expanded || toolRenderer?.alwaysExpanded) || block.output.length === 0) return box

  const width = Math.max(1, ctx.width - GUTTER * 2 - 4)
  const coreOutput = bounded || coreFailed
  const maxRows = coreOutput ? MAX_OUTPUT_ROWS : (toolRenderer?.maxRows ?? MAX_OUTPUT_ROWS)
  const customOutput = coreOutput ? undefined : toolRenderer?.renderOutput?.(block.output, width)
  const output = customOutput ?? renderToolOutput(block.output, width, maxRows)
  const body = detailPanel(ctx, { marginLeft: 2 })
  const content = label(ctx, { content: output.content, height: output.rows })
  if (!customOutput) {
    content.wrapMode = "char"
    content.truncate = false
  }
  body.add(content)
  box.add(body)
  return box
}
