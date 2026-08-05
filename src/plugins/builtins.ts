import type { Plugin } from "./types"
import bash from "./bash/plugin"
import cli from "./cli/plugin"
import files from "./files/plugin"
import openaiChatgpt from "./openai-chatgpt/plugin"
import prompt from "./prompt/plugin"
import projectInstructions from "./project-instructions/plugin"
import search from "./search/plugin"
import tui from "./tui/plugin"

export const builtinPlugins: Plugin[] = [prompt, projectInstructions, bash, files, search, openaiChatgpt, cli, tui]
