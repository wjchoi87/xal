import { openaiChatgptProvider } from "../providers/openai-chatgpt"
import { registerProvider } from "../providers/registry"
import { bashTool } from "../tools/bash"
import { registerTool } from "../tools/registry"
import "./login"
import "./models"
import "./ask"

registerProvider(openaiChatgptProvider)
registerTool(bashTool)
