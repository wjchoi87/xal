import { ProviderError } from "../../providers/errors"
import { defaultClientIdentity, type ClientIdentity } from "../../providers/identity"
import { errorDetail, httpError, providerFetch } from "../../providers/transport"
import { ensureAuth, type AnthropicAuth } from "./auth"

export const API_URL = "https://api.anthropic.com"

let identity = defaultClientIdentity()

export function setClientIdentity(value: ClientIdentity): void {
  identity = value
}

function headers(auth: AnthropicAuth, extra: Record<string, string>): Record<string, string> {
  const base = {
    accept: "application/json",
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
    "anthropic-dangerous-direct-browser-access": "true",
  }
  if (auth.type === "api_key") {
    return {
      ...base,
      "x-api-key": auth.key,
      "anthropic-beta": "interleaved-thinking-2025-05-14",
      "user-agent": identity.userAgent,
      ...extra,
    }
  }
  return {
    ...base,
    authorization: `Bearer ${auth.access}`,
    "anthropic-beta": "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14",
    "user-agent": "claude-cli/2.1.75",
    "x-app": "cli",
    ...extra,
  }
}

async function raiseForStatus(response: Response): Promise<never> {
  if (response.status === 401) {
    throw new ProviderError("Anthropic authentication failed", { retryable: false })
  }
  if (response.status === 403) {
    throw new ProviderError("Anthropic denied access for this credential or model", { retryable: false })
  }
  const text = await response.text().catch(() => "")
  throw httpError("Anthropic", response, errorDetail(text) ?? text.slice(0, 500))
}

interface AnthropicRequest extends Omit<RequestInit, "headers"> {
  headers?: Record<string, string>
}

export async function anthropicFetch(path: string, init: AnthropicRequest = {}): Promise<Response> {
  let auth = await ensureAuth()
  const send = () =>
    providerFetch(
      "Anthropic",
      () =>
        fetch(`${API_URL}${path}`, {
          ...init,
          headers: headers(auth, init.headers ?? {}),
        }),
      init.signal,
    )

  let response = await send()
  if (response.status === 401 && auth.type === "oauth") {
    auth = await ensureAuth(true)
    response = await send()
  }
  if (!response.ok) await raiseForStatus(response)
  return response
}
