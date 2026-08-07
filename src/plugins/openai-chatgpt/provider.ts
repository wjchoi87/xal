import type { Provider } from "../../providers/types"
import { isLoggedIn, login, PROVIDER_ID } from "./oauth"
import { defaultModel, listModels, thinking } from "./models"
import { streamResponse } from "./transport"

export const openaiChatgptProvider: Provider = {
  id: PROVIDER_ID,
  name: "OpenAI (ChatGPT subscription)",
  aliases: ["chatgpt"],
  capabilities: { imageInput: true },
  isLoggedIn,
  connect: login,
  listModels,
  defaultModel,
  thinking,
  stream: streamResponse,
}
