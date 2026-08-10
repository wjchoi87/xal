import type { Plugin } from "./types"
import ask from "./ask/plugin"
import bash from "./bash/plugin"
import codeReview from "./code-review/plugin"
import deepseek from "./deepseek/plugin"
import files from "./files/plugin"
import headless from "./headless/plugin"
import openaiChatgpt from "./openai-chatgpt/plugin"
import permissions from "./permissions/plugin"
import plan from "./plan/plugin"
import prompt from "./prompt/plugin"
import promptCommands from "./prompt-commands/plugin"
import projectInstructions from "./project-instructions/plugin"
import search from "./search/plugin"
import skills from "./skills/plugin"
import tasks from "./tasks/plugin"
import tui from "./tui/plugin"

export const builtinPlugins: Plugin[] = [
  permissions,
  prompt,
  plan,
  codeReview,
  promptCommands,
  projectInstructions,
  bash,
  files,
  search,
  skills,
  tasks,
  deepseek,
  openaiChatgpt,
  headless,
  ask,
  tui,
]
