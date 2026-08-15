import type { Provider } from "../../providers/types"
import { PROVIDER_ID } from "./api"
import { connect, isLoggedIn } from "./auth"
import { defaultModel, listModels } from "./models"
import { streamResponse } from "./transport"

export const alibabaCloudProvider: Provider = {
  id: PROVIDER_ID,
  name: "Alibaba Cloud Model Studio",
  aliases: ["dashscope"],
  capabilities: { imageInput: false },
  isLoggedIn,
  connect,
  listModels,
  defaultModel,
  stream: streamResponse,
}
