import { providerFetch } from "../../providers/transport"
import { clientIdentity } from "./identity"
import { ensureAccessToken } from "./oauth"

const CODEX_URL = "https://chatgpt.com/backend-api/codex"

interface ChatGptRequest extends Omit<RequestInit, "headers"> {
  headers?: Record<string, string>
}

function headers(access: string, accountId: string, extra: Record<string, string>): Record<string, string> {
  const identity = clientIdentity()
  return {
    authorization: `Bearer ${access}`,
    "chatgpt-account-id": accountId,
    originator: identity.name,
    accept: "application/json",
    "user-agent": identity.userAgent,
    ...extra,
  }
}

export async function chatGptFetch(path: string, init: ChatGptRequest = {}): Promise<Response> {
  let auth = await ensureAccessToken()
  const send = () =>
    providerFetch(
      "ChatGPT",
      () =>
        fetch(`${CODEX_URL}${path}`, {
          ...init,
          headers: headers(auth.access, auth.accountId, init.headers ?? {}),
        }),
      init.signal,
    )

  let response = await send()
  if (response.status !== 401) return response
  auth = await ensureAccessToken(true)
  response = await send()
  return response
}
