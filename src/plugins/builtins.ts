import type { Plugin } from "./types"
import ask from "./ask/plugin"
import bash from "./bash/plugin"
import deepseek from "./deepseek/plugin"
import files from "./files/plugin"
import headless from "./headless/plugin"
import openaiChatgpt from "./openai-chatgpt/plugin"
import permissions from "./permissions/plugin"
import prompt from "./prompt/plugin"
import projectInstructions from "./project-instructions/plugin"
import search from "./search/plugin"
import tasks from "./tasks/plugin"
import tui from "./tui/plugin"

export const builtinPlugins: Plugin[] = [
  permissions,
  prompt,
  projectInstructions,
  bash,
  files,
  search,
  tasks,
  deepseek,
  openaiChatgpt,
  headless,
  ask,
  tui,
]
