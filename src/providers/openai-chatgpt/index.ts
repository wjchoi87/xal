import type { Provider } from "../types"
import { isLoggedIn, login, PROVIDER_ID } from "./oauth"
import { defaultModel, listModels } from "./models"
import { streamResponse } from "./transport"

export const openaiChatgptProvider: Provider = {
  id: PROVIDER_ID,
  name: "OpenAI (ChatGPT subscription)",
  aliases: ["chatgpt"],
  login,
  isLoggedIn,
  listModels,
  defaultModel,
  stream: streamResponse,
}
