import type { Provider } from "../../providers/types"
import { isLoggedIn, login, PROVIDER_ID } from "./oauth"
import { defaultModel, listModels } from "./models"
import { streamResponse } from "./transport"

export const openaiChatgptProvider: Provider = {
  id: PROVIDER_ID,
  name: "OpenAI (ChatGPT subscription)",
  aliases: ["chatgpt"],
  isLoggedIn,
  connect: login,
  listModels,
  defaultModel,
  stream: streamResponse,
}
