export interface ProviderErrorOptions {
  retryable: boolean
  retryAfterMs?: number
}

export class ProviderError extends Error {
  readonly retryable: boolean
  readonly retryAfterMs: number | undefined

  constructor(message: string, options: ProviderErrorOptions) {
    super(message)
    this.name = "ProviderError"
    this.retryable = options.retryable
    this.retryAfterMs = options.retryAfterMs
  }
}
