import type { Provider } from "../../providers/types"
import { login, PROVIDER_ID } from "./oauth"
import { defaultModel, listModels } from "./models"
import { streamResponse } from "./transport"

export const openaiChatgptProvider: Provider = {
  id: PROVIDER_ID,
  name: "OpenAI ChatGPT",
  aliases: ["chatgpt"],
  capabilities: { imageInput: true },
  connect: login,
  listModels,
  defaultModel,
  stream: streamResponse,
}
