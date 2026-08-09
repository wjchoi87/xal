import { asString, isRecord } from "../../lib/json"
import type { ElicitationOption, ElicitationQuestion, InteractiveTool } from "../../tools/types"

const MAX_QUESTIONS = 3
const MIN_OPTIONS = 2
const MAX_OPTIONS = 3
const MAX_HEADER_LENGTH = 12
const MAX_LABEL_LENGTH = 40
const MAX_QUESTION_LENGTH = 200
const MAX_DESCRIPTION_LENGTH = 120

function text(value: unknown, field: string, maximum: number): string {
  const parsed = asString(value)?.trim()
  if (!parsed) throw new Error(`${field} is required`)
  if (parsed.length > maximum) throw new Error(`${field} must be at most ${maximum} characters`)
  return parsed
}

function parseOption(value: unknown, question: number, option: number): ElicitationOption {
  if (!isRecord(value)) throw new Error(`questions[${question}].options[${option}] must be an object`)
  return {
    label: text(value.label, `questions[${question}].options[${option}].label`, MAX_LABEL_LENGTH),
    description: text(
      value.description,
      `questions[${question}].options[${option}].description`,
      MAX_DESCRIPTION_LENGTH,
    ),
  }
}

function parseQuestion(value: unknown, index: number): ElicitationQuestion {
  if (!isRecord(value)) throw new Error(`questions[${index}] must be an object`)

  const id = text(value.id, `questions[${index}].id`, MAX_LABEL_LENGTH)
  if (!/^[a-z][a-z0-9_]*$/.test(id)) {
    throw new Error(`questions[${index}].id must use lower-case letters, numbers, and underscores`)
  }
  if (!Array.isArray(value.options) || value.options.length < MIN_OPTIONS || value.options.length > MAX_OPTIONS) {
    throw new Error(`questions[${index}].options must contain ${MIN_OPTIONS} to ${MAX_OPTIONS} choices`)
  }

  const options = value.options.map((option, optionIndex) => parseOption(option, index, optionIndex))
  if (new Set(options.map((option) => option.label.toLowerCase())).size !== options.length) {
    throw new Error(`questions[${index}].options must have unique labels`)
  }

  return {
    id,
    header: text(value.header, `questions[${index}].header`, MAX_HEADER_LENGTH),
    question: text(value.question, `questions[${index}].question`, MAX_QUESTION_LENGTH),
    options,
  }
}

function parseQuestions(args: Record<string, unknown>): ElicitationQuestion[] {
  if (!Array.isArray(args.questions) || args.questions.length < 1 || args.questions.length > MAX_QUESTIONS) {
    throw new Error(`questions must contain 1 to ${MAX_QUESTIONS} entries`)
  }
  const questions = args.questions.map(parseQuestion)
  if (new Set(questions.map((question) => question.id)).size !== questions.length) {
    throw new Error("questions must have unique ids")
  }
  return questions
}

export const requestUserInputTool: InteractiveTool = {
  name: "request_user_input",
  description:
    "Ask the user one to three structured questions when their decision is required. Each question offers two or three exclusive choices plus a free-form alternative.",
  parameters: {
    type: "object",
    properties: {
      questions: {
        type: "array",
        minItems: 1,
        maxItems: MAX_QUESTIONS,
        items: {
          type: "object",
          properties: {
            id: {
              type: "string",
              pattern: "^[a-z][a-z0-9_]*$",
              maxLength: MAX_LABEL_LENGTH,
              description: "Stable identifier used to associate the answer with this question",
            },
            header: {
              type: "string",
              maxLength: MAX_HEADER_LENGTH,
              description: "Short label for the question",
            },
            question: {
              type: "string",
              maxLength: MAX_QUESTION_LENGTH,
              description: "The decision the user needs to make",
            },
            options: {
              type: "array",
              minItems: MIN_OPTIONS,
              maxItems: MAX_OPTIONS,
              items: {
                type: "object",
                properties: {
                  label: { type: "string", maxLength: MAX_LABEL_LENGTH },
                  description: { type: "string", maxLength: MAX_DESCRIPTION_LENGTH },
                },
                required: ["label", "description"],
                additionalProperties: false,
              },
            },
          },
          required: ["id", "header", "question", "options"],
          additionalProperties: false,
        },
      },
    },
    required: ["questions"],
    additionalProperties: false,
  },
  prompt:
    "Use request_user_input only when a missing decision blocks progress. Ask related questions together, keep options distinct, and do not use it to authorize tool actions.",
  interactive: true,
  title(args) {
    const count = Array.isArray(args.questions) ? args.questions.length : 0
    if (count === 1) return "Ask one question"
    return count > 1 ? `Ask ${count} questions` : "Ask questions"
  },
  readOnly() {
    return true
  },
  async execute(args, ctx) {
    const result = await ctx.requestInput({ questions: parseQuestions(args) })
    if (result.status === "rejected") return { output: JSON.stringify({ status: "rejected" }) }
    return {
      output: JSON.stringify({
        status: "answered",
        answers: Object.fromEntries(result.answers.map((answer) => [answer.questionId, answer.value])),
      }),
    }
  },
}
