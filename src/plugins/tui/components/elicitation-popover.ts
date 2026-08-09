import {
  InputRenderable,
  StyledText,
  TextAttributes,
  type BoxRenderable,
  type RenderContext,
  type TextRenderable,
} from "@opentui/core"
import { MAX_ELICITATION_ANSWER_LENGTH } from "../../../tools/types"
import type { ElicitationAnswer, ElicitationQuestion } from "../../../tools/types"
import { column, label, paragraph, row } from "../lib/renderables"
import { terminalGlyph } from "../lib/text"
import { COLORS } from "../theme/colors"
import { background, border, inputColors, muted, paint } from "../theme/styles"

const MAX_ROWS = 4

export interface ElicitationPopoverActions {
  answer(requestId: string, answers: ElicitationAnswer[]): void
  reject(requestId: string): void
}

export class ElicitationPopover {
  readonly view: BoxRenderable
  private readonly heading: TextRenderable
  private readonly progress: TextRenderable
  private readonly prompt: TextRenderable
  private readonly rows: TextRenderable[] = []
  private readonly inputRow: BoxRenderable
  private readonly input: InputRenderable
  private readonly hint: TextRenderable
  private requestId: string | undefined
  private questions: ElicitationQuestion[] = []
  private answers: Array<string | undefined> = []
  private questionIndex = 0
  private selected = 0
  private enteringText = false
  private reviewing = false
  private returnToReview = false

  get visible(): boolean {
    return this.view.visible
  }

  get height(): number {
    if (this.reviewing) return this.questions.length + 8
    const choices = this.questions[this.questionIndex]?.options.length ?? 0
    return (this.enteringText ? 1 : choices + 1) + 7
  }

  constructor(
    ctx: RenderContext,
    private readonly actions: ElicitationPopoverActions,
    private readonly onChange: () => void,
  ) {
    this.view = column(ctx, {
      visible: false,
      border: true,
      borderStyle: "rounded",
      paddingLeft: 1,
      paddingRight: 1,
      marginLeft: 1,
      marginRight: 1,
      marginTop: 1,
      ...background(),
      ...border(COLORS.agent),
    })

    const header = row(ctx, { height: 1 })
    header.add(label(ctx, { content: "?", width: 2, attributes: TextAttributes.BOLD, color: COLORS.agent }))
    this.heading = label(ctx, { content: "", flexGrow: 1, flexShrink: 1, minWidth: 1 })
    this.progress = label(ctx, { content: "", flexShrink: 0, marginLeft: 1, color: COLORS.faint })
    header.add(this.heading)
    header.add(this.progress)
    this.view.add(header)

    this.prompt = paragraph(ctx, { content: "", height: 2, marginLeft: 2 })
    this.view.add(this.prompt)

    for (let index = 0; index < MAX_ROWS; index++) {
      const option = label(ctx, { content: "", marginLeft: 2 })
      this.rows.push(option)
      this.view.add(option)
    }

    this.inputRow = row(ctx, { visible: false, height: 1, marginLeft: 2 })
    this.inputRow.add(label(ctx, { content: "Other:", width: 7, color: COLORS.accent }))
    this.input = new InputRenderable(ctx, {
      placeholder: "Type your answer",
      maxLength: MAX_ELICITATION_ANSWER_LENGTH,
      flexGrow: 1,
      flexShrink: 1,
      minWidth: 1,
      ...inputColors(),
    })
    this.inputRow.add(this.input)
    this.view.add(this.inputRow)

    this.hint = label(ctx, { content: "", marginLeft: 2, color: COLORS.faint })
    this.view.add(this.hint)
  }

  show(requestId: string, questions: ElicitationQuestion[]): void {
    this.close()
    if (questions.length === 0) {
      this.actions.reject(requestId)
      return
    }
    this.requestId = requestId
    this.questions = questions
    this.answers = Array.from({ length: questions.length })
    this.questionIndex = 0
    this.selected = 0
    this.enteringText = false
    this.reviewing = false
    this.returnToReview = false
    this.view.visible = true
    this.render()
    this.onChange()
  }

  hide(): void {
    this.close()
  }

  focus(): void {
    if (this.enteringText && this.visible) this.input.focus()
  }

  blur(): void {
    this.input.blur()
  }

  handleKey(name: string): boolean {
    if (!this.visible) return false
    if (this.reviewing) return this.handleReviewKey(name)
    if (this.enteringText) return this.handleTextKey(name)
    if (name === "left") {
      this.openQuestion(this.questionIndex - 1)
      return true
    }
    if (name === "right") {
      this.openNext()
      return true
    }
    if (name === "up" || name === "down") {
      this.move(name === "up" ? -1 : 1)
      return true
    }
    if (name === "escape") {
      if (this.returnToReview) {
        this.openReview()
        return true
      }
      this.reject()
      return true
    }
    const shortcut = Number(name)
    const count = (this.questions[this.questionIndex]?.options.length ?? 0) + 1
    if (Number.isInteger(shortcut) && shortcut >= 1 && shortcut <= count) {
      this.selected = shortcut - 1
      this.confirm()
      return true
    }
    if (name === "return" || name === "enter") this.confirm()
    return true
  }

  private handleReviewKey(name: string): boolean {
    if (name === "return" || name === "enter") {
      this.submit()
      return true
    }
    if (name === "left" || name === "escape") {
      this.returnToReview = true
      this.openQuestion(this.questions.length - 1)
      return true
    }
    const shortcut = Number(name)
    if (Number.isInteger(shortcut) && shortcut >= 1 && shortcut <= this.questions.length) {
      this.returnToReview = true
      this.openQuestion(shortcut - 1)
    }
    return true
  }

  private handleTextKey(name: string): boolean {
    if (name === "escape") {
      this.enteringText = false
      this.input.value = ""
      this.input.blur()
      this.selected = this.selectionFor(this.questionIndex)
      this.render()
      this.onChange()
      return true
    }
    if (name === "return" || name === "enter") {
      const value = this.input.value.trim()
      if (value) this.save(value)
      return true
    }
    return false
  }

  private move(delta: number): void {
    const count = (this.questions[this.questionIndex]?.options.length ?? 0) + 1
    this.selected = (this.selected + delta + count) % count
    this.renderOptions()
  }

  private confirm(): void {
    const question = this.questions[this.questionIndex]
    if (!question) return
    const option = question.options[this.selected]
    if (option) {
      this.save(option.label)
      return
    }
    this.enteringText = true
    this.input.value = this.customAnswer(this.questionIndex) ?? ""
    this.render()
    this.input.focus()
    this.onChange()
  }

  private save(value: string): void {
    this.answers[this.questionIndex] = value
    if (this.returnToReview) {
      this.openReview()
      return
    }
    this.openNext()
  }

  private openNext(): void {
    if (!this.answers[this.questionIndex]) return
    if (this.questionIndex + 1 < this.questions.length) {
      this.openQuestion(this.questionIndex + 1)
      return
    }
    if (this.answers.every((answer) => answer)) this.openReview()
  }

  private openQuestion(index: number): void {
    if (index < 0 || index >= this.questions.length) return
    this.questionIndex = index
    this.selected = this.selectionFor(index)
    this.enteringText = false
    this.reviewing = false
    this.input.value = ""
    this.input.blur()
    this.render()
    this.onChange()
  }

  private openReview(): void {
    this.enteringText = false
    this.reviewing = true
    this.returnToReview = false
    this.input.value = ""
    this.input.blur()
    this.render()
    this.onChange()
  }

  private selectionFor(index: number): number {
    const question = this.questions[index]
    const answer = this.answers[index]
    if (!question || !answer) return 0
    const selected = question.options.findIndex((option) => option.label === answer)
    return selected < 0 ? question.options.length : selected
  }

  private customAnswer(index: number): string | undefined {
    const question = this.questions[index]
    const answer = this.answers[index]
    if (!question || !answer || question.options.some((option) => option.label === answer)) return undefined
    return answer
  }

  private submit(): void {
    const requestId = this.requestId
    const answers = this.questions.flatMap((question, index): ElicitationAnswer[] => {
      const value = this.answers[index]
      return value ? [{ questionId: question.id, value }] : []
    })
    if (!requestId || answers.length !== this.questions.length) return
    this.close()
    this.actions.answer(requestId, answers)
  }

  private reject(): void {
    const requestId = this.requestId
    this.close()
    if (requestId) this.actions.reject(requestId)
  }

  private close(): void {
    const changed = this.view.visible
    this.view.visible = false
    this.input.blur()
    this.input.value = ""
    this.requestId = undefined
    this.questions = []
    this.answers = []
    this.questionIndex = 0
    this.selected = 0
    this.enteringText = false
    this.reviewing = false
    this.returnToReview = false
    if (changed) this.onChange()
  }

  private render(): void {
    if (this.reviewing) {
      this.renderReview()
      return
    }
    const question = this.questions[this.questionIndex]
    if (!question) return
    this.heading.content = new StyledText([paint(COLORS.agent, question.header)])
    this.progress.content = `${this.questionIndex + 1}/${this.questions.length + 1}`
    this.prompt.content = question.question
    this.renderOptions()
    this.inputRow.visible = this.enteringText
    this.hint.content = this.enteringText
      ? "Enter answer · Esc choices"
      : `←→ questions · ↑↓/1-${question.options.length + 1} choose · Enter · Esc decline`
    this.view.height = this.height - 1
  }

  private renderOptions(): void {
    const question = this.questions[this.questionIndex]
    const custom = this.customAnswer(this.questionIndex)
    const options = question
      ? [...question.options, { label: "Other", description: custom ?? "Type a different answer" }]
      : []
    const answer = this.answers[this.questionIndex]
    this.rows.forEach((line, index) => {
      const option = options[index]
      if (!option || this.enteringText) {
        line.visible = false
        line.content = ""
        return
      }
      line.visible = true
      const selected = index === this.selected
      const chosen = index === question?.options.length ? custom !== undefined : option.label === answer
      const cursor = selected ? terminalGlyph("❯", ">") : " "
      const marker = chosen ? terminalGlyph("●", "x") : terminalGlyph("○", " ")
      const text = `${cursor} ${marker} [${index + 1}] ${option.label} — ${option.description}`
      line.content = new StyledText([
        selected ? paint(COLORS.accent, text) : chosen ? paint(COLORS.success, text) : muted(text),
      ])
    })
  }

  private renderReview(): void {
    this.heading.content = new StyledText([paint(COLORS.agent, "Review")])
    this.progress.content = `${this.questions.length + 1}/${this.questions.length + 1}`
    this.prompt.content = "Review your answers, then submit."
    this.inputRow.visible = false
    this.rows.forEach((line, index) => {
      const question = this.questions[index]
      if (question) {
        line.visible = true
        line.content = new StyledText([
          muted(`[${index + 1}] `),
          paint(COLORS.foreground, question.header),
          muted(` — ${this.answers[index] ?? ""}`),
        ])
        return
      }
      if (index === this.questions.length) {
        line.visible = true
        line.content = new StyledText([paint(COLORS.accent, `${terminalGlyph("❯", ">")} Submit answers`)])
        return
      }
      line.visible = false
      line.content = ""
    })
    this.hint.content = `${this.questions.length === 1 ? "1 edit" : `1-${this.questions.length} edit`} · ←/Esc back · Enter submit`
    this.view.height = this.height - 1
  }
}
