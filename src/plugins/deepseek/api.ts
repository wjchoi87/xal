import { appInfo } from "../../app-info"
import { describeError } from "../../lib/error"
import { asString, isRecord } from "../../lib/json"
import { ProviderError } from "../../providers/errors"

export const PROVIDER_ID = "deepseek"
export const API_URL = "https://api.deepseek.com"

function retryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000
  const date = Date.parse(value)
  if (Number.isNaN(date)) return undefined
  return Math.max(0, date - Date.now())
}

function errorDetail(text: string): string | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isRecord(parsed)) return undefined
  const error = isRecord(parsed.error) ? asString(parsed.error.message) : undefined
  return error ?? asString(parsed.message)
}

async function raiseForStatus(response: Response): Promise<never> {
  const text = await response.text().catch(() => "")
  const detail = errorDetail(text) ?? text.slice(0, 500)
  if (response.status === 401) {
    throw new ProviderError("DeepSeek authentication failed", { retryable: false })
  }
  if (response.status === 402) {
    throw new ProviderError("DeepSeek balance is insufficient", { retryable: false })
  }
  const delayMs = retryAfterMs(response.headers.get("retry-after"))
  if (response.status === 429) {
    throw new ProviderError(
      delayMs === undefined ? "DeepSeek rate limit reached" : `DeepSeek rate limited — retry in ${delayMs / 1_000}s`,
      {
        retryable: true,
        retryAfterMs: delayMs,
      },
    )
  }
  throw new ProviderError(`DeepSeek request failed (${response.status})${detail ? `: ${detail}` : ""}`, {
    retryable: response.status === 408 || response.status >= 500,
    retryAfterMs: delayMs,
  })
}

export async function deepSeekFetch(path: string, key: string, init: RequestInit = {}): Promise<Response> {
  let response: Response
  try {
    response = await fetch(`${API_URL}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${key}`,
        accept: "application/json",
        "content-type": "application/json",
        "user-agent": `${appInfo.name}/${appInfo.version}`,
        ...init.headers,
      },
    })
  } catch (error) {
    if (init.signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw error
    throw new ProviderError(`DeepSeek request failed: ${describeError(error)}`, { retryable: true })
  }
  if (!response.ok) await raiseForStatus(response)
  return response
}
