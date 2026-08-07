import { appInfo } from "../../app-info"
import { ProviderError } from "../../providers/errors"
import { errorDetail, httpError, providerFetch } from "../../providers/transport"

export const PROVIDER_ID = "deepseek"
export const API_URL = "https://api.deepseek.com"

async function raiseForStatus(response: Response): Promise<never> {
  if (response.status === 401) {
    throw new ProviderError("DeepSeek authentication failed", { retryable: false })
  }
  if (response.status === 402) {
    throw new ProviderError("DeepSeek balance is insufficient", { retryable: false })
  }
  const text = await response.text().catch(() => "")
  throw httpError("DeepSeek", response, errorDetail(text) ?? text.slice(0, 500))
}

export async function deepSeekFetch(path: string, key: string, init: RequestInit = {}): Promise<Response> {
  const response = await providerFetch(
    "DeepSeek",
    () =>
      fetch(`${API_URL}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${key}`,
          accept: "application/json",
          "content-type": "application/json",
          "user-agent": `${appInfo.name}/${appInfo.version}`,
          ...init.headers,
        },
      }),
    init.signal,
  )
  if (!response.ok) await raiseForStatus(response)
  return response
}
