import type { Provider } from "../../providers/types"
import { PROVIDER_ID } from "./api"
import { connect, isLoggedIn } from "./auth"
import { defaultModel, listModels, thinking } from "./models"
import { streamResponse } from "./transport"

export const deepSeekProvider: Provider = {
  id: PROVIDER_ID,
  name: "DeepSeek",
  aliases: [],
  capabilities: { imageInput: false },
  isLoggedIn,
  connect,
  listModels,
  defaultModel,
  thinking,
  stream: streamResponse,
}
