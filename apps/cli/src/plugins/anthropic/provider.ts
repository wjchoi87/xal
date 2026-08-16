import type { Provider } from "../../providers/types"
import { connect, isLoggedIn, PROVIDER_ID } from "./auth"
import { defaultModel, listModels } from "./models"
import { streamResponse } from "./transport"

export const anthropicProvider: Provider = {
  id: PROVIDER_ID,
  name: "Anthropic",
  aliases: ["claude"],
  capabilities: { imageInput: true },
  isLoggedIn,
  connect,
  listModels,
  defaultModel,
  stream: streamResponse,
}
