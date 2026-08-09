import {
  BoxRenderable,
  decodePasteBytes,
  RenderableEvents,
  stripAnsiSequences,
  SyntaxStyle,
  TextareaRenderable,
  TextAttributes,
  type PasteEvent,
  type RenderContext,
} from "@opentui/core"
import { appInfo } from "../../../app-info"
import { asNumber, asString, isRecord } from "../../../lib/json"
import type { ImageInput, UserInput } from "../../../providers/types"
import { label, row } from "../lib/renderables"
import { COLORS, resolveColor } from "../theme/colors"
import { border, inputColors } from "../theme/styles"

export const COMPOSER_ROWS = 4

interface ComposerActions {
  submit(input: UserInput): boolean
  run(line: string): void
  change(value: string): void
  resize(): void
}

interface PastedContent {
  kind: "pasted-content"
  text: string
}

interface PastedImage {
  kind: "pasted-image"
  number: number
  image: ImageInput
}

function isPastedContent(value: unknown): value is PastedContent {
  return isRecord(value) && value.kind === "pasted-content" && asString(value.text) !== undefined
}

function isPastedImage(value: unknown): value is PastedImage {
  if (!isRecord(value) || value.kind !== "pasted-image" || asNumber(value.number) === undefined) return false
  const image = value.image
  return (
    isRecord(image) &&
    (image.mediaType === "image/png" || image.mediaType === "image/jpeg") &&
    asString(image.data) !== undefined
  )
}

async function linuxClipboardImage(): Promise<Bun.Image | undefined> {
  for (const command of [
    ["wl-paste", "--no-newline", "--type", "image/png"],
    ["wl-paste", "--no-newline", "--type", "image/jpeg"],
    ["xclip", "-selection", "clipboard", "-t", "image/png", "-o"],
    ["xclip", "-selection", "clipboard", "-t", "image/jpeg", "-o"],
  ]) {
    try {
      const child = Bun.spawn(command, { stdin: "ignore", stdout: "pipe", stderr: "ignore" })
      const bytes = await new Response(child.stdout).bytes()
      if ((await child.exited) === 0 && bytes.length > 0) return new Bun.Image(bytes)
    } catch {}
  }
}

export class Composer {
  readonly view: BoxRenderable
  private readonly input: TextareaRenderable
  private readonly pastedContentType: number
  private readonly pastedImageType: number
  private readonly syntaxStyle: SyntaxStyle
  private readonly imageStyleId: number
  private currentRows = COMPOSER_ROWS
  private readingImage = false

  constructor(
    private readonly ctx: RenderContext,
    private readonly actions: ComposerActions,
  ) {
    this.view = row(ctx, {
      height: 3,
      alignItems: "flex-start",
      border: true,
      borderStyle: "rounded",
      paddingLeft: 1,
      paddingRight: 1,
      marginLeft: 1,
      marginRight: 1,
      marginTop: 1,
      ...border(COLORS.border),
    })

    this.view.add(label(ctx, { content: "❯", width: 2, attributes: TextAttributes.BOLD, color: COLORS.accent }))
    this.syntaxStyle = SyntaxStyle.create()
    this.imageStyleId = this.syntaxStyle.registerStyle("composer-image", { fg: resolveColor(COLORS.accent) })
    this.input = new TextareaRenderable(ctx, {
      placeholder: `Ask ${appInfo.name} anything · / for commands`,
      height: 1,
      flexGrow: 1,
      flexShrink: 1,
      flexBasis: 0,
      minWidth: 1,
      wrapMode: "word",
      keyBindings: [
        { name: "return", action: "submit" },
        { name: "kpenter", action: "submit" },
        { name: "return", shift: true, action: "newline" },
        { name: "kpenter", shift: true, action: "newline" },
        { name: "linefeed", shift: true, action: "newline" },
        { name: "return", meta: true, action: "newline" },
        { name: "kpenter", meta: true, action: "newline" },
        { name: "j", ctrl: true, action: "newline" },
      ],
      onContentChange: () => this.change(),
      onSubmit: () => this.submit(),
      onPaste: (event) => this.paste(event),
      syntaxStyle: this.syntaxStyle,
      ...inputColors(),
    })
    this.pastedContentType = this.input.extmarks.registerType("composer-pasted-content")
    this.pastedImageType = this.input.extmarks.registerType("composer-pasted-image")
    this.view.add(this.input)
    this.view.on(RenderableEvents.DESTROYED, () => this.syntaxStyle.destroy())
  }

  get rows(): number {
    return this.currentRows
  }

  setValue(text: string): void {
    this.input.setText(text)
    this.input.gotoBufferEnd()
    this.reflow()
  }

  clear(): boolean {
    if (!this.input.plainText) return false
    this.setValue("")
    return true
  }

  restore(inputs: UserInput[]): void {
    if (inputs.length === 0) return
    const hadDraft = this.input.plainText.length > 0
    this.input.gotoBufferHome()
    inputs.forEach((input, index) => {
      if (index > 0) this.input.insertText("\n")
      if (input.text) this.input.insertText(input.text)
      input.images.forEach((image, imageIndex) => {
        if (input.text || imageIndex > 0) this.input.insertText(" ")
        this.attachImage(image)
      })
    })
    if (hadDraft) this.input.insertText("\n")
    this.input.gotoBufferEnd()
    this.reflow()
  }

  newLine(): void {
    this.input.newLine()
  }

  async pasteImage(): Promise<boolean> {
    if (this.readingImage) return false
    this.readingImage = true
    try {
      const clipboard = process.platform === "linux" ? await linuxClipboardImage() : Bun.Image.fromClipboard()
      if (!clipboard) return false
      this.attachImage({ mediaType: "image/png", data: await clipboard.png().toBase64() })
      return true
    } catch {
      return false
    } finally {
      this.readingImage = false
    }
  }

  private attachImage(image: ImageInput): void {
    const numbers = this.input.extmarks
      .getAllForTypeId(this.pastedImageType)
      .flatMap((mark) => (isPastedImage(mark.data) ? [mark.data.number] : []))
    const number = Math.max(0, ...numbers) + 1
    const text = `[Image #${number}]`
    this.input.insertText(text)
    const end = this.input.cursorOffset
    this.input.extmarks.create({
      start: end - text.length,
      end,
      virtual: true,
      styleId: this.imageStyleId,
      typeId: this.pastedImageType,
      data: { kind: "pasted-image", number, image } satisfies PastedImage,
    })
  }

  reflow(): void {
    const totalRows = this.input.plainText ? this.input.editorView.getTotalVirtualLineCount() : 1
    const terminalRows = this.ctx.terminalHeight ?? this.ctx.height
    const inputRows = Math.min(totalRows, Math.max(1, Math.min(10, terminalRows - 5)))
    const rows = inputRows + 3
    if (rows === this.currentRows) return
    this.input.height = inputRows
    this.view.height = inputRows + 2
    this.currentRows = rows
    this.actions.resize()
  }

  setVisible(visible: boolean): void {
    this.view.visible = visible
  }

  focus(): void {
    this.input.focus()
  }

  blur(): void {
    this.input.blur()
  }

  private change(): void {
    this.reflow()
    this.actions.change(this.input.plainText)
  }

  private paste(event: PasteEvent): void {
    event.preventDefault()
    const text = stripAnsiSequences(decodePasteBytes(event.bytes))
    if (!text) return
    if (text.split(/\r\n|\r|\n/).length < 3) {
      this.input.insertText(text)
      return
    }
    const label = `[Pasted Content ${text.length} chars]`
    this.input.insertText(label)
    const end = this.input.cursorOffset
    this.input.extmarks.create({
      start: end - label.length,
      end,
      virtual: true,
      typeId: this.pastedContentType,
      data: { kind: "pasted-content", text } satisfies PastedContent,
    })
  }

  private submission(): UserInput {
    let text = this.input.plainText
    const pastes = this.input.extmarks
      .getAllForTypeId(this.pastedContentType)
      .flatMap((mark) => (isPastedContent(mark.data) ? [{ ...mark, text: mark.data.text }] : []))
    const imageMarks = this.input.extmarks
      .getAllForTypeId(this.pastedImageType)
      .flatMap((mark) => (isPastedImage(mark.data) ? [{ ...mark, image: mark.data.image }] : []))
    const edits = [...pastes, ...imageMarks.map((mark) => ({ ...mark, text: "" }))].sort(
      (left, right) => right.start - left.start,
    )
    for (const edit of edits) {
      const start = this.input.getTextRange(0, edit.start).length
      const end = this.input.getTextRange(0, edit.end).length
      text = text.slice(0, start) + edit.text + text.slice(end)
    }
    return {
      text: text.trim(),
      images: imageMarks.sort((left, right) => left.start - right.start).map((mark) => mark.image),
    }
  }

  private submit(): void {
    const submission = this.submission()
    if (!submission.text && submission.images.length === 0) return
    if (submission.images.length === 0 && submission.text.startsWith("/")) {
      this.setValue("")
      this.actions.run(submission.text)
      return
    }
    if (this.actions.submit(submission)) this.setValue("")
  }
}
