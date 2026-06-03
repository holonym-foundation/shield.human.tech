import axios, { type AxiosInstance, type AxiosError } from 'axios'

const DEFAULT_TIMEOUT_MS = 30_000

export class BridgeApiClient {
  private client: AxiosInstance
  private authToken: string | null = null

  constructor(baseUrl: string, options?: { timeoutMs?: number }) {
    this.client = axios.create({
      baseURL: baseUrl.replace(/\/$/, ''),
      timeout: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      headers: { 'Content-Type': 'application/json' },
    })

    this.client.interceptors.request.use((config) => {
      if (this.authToken) {
        config.headers.Authorization = `Bearer ${this.authToken}`
      }
      return config
    })
  }

  setAuthToken(token: string): void {
    this.authToken = token
  }

  clearAuthToken(): void {
    this.authToken = null
  }

  hasAuthToken(): boolean {
    return this.authToken !== null
  }

  async get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path)
  }

  async getText(path: string): Promise<string> {
    try {
      const res = await this.client.request<string>({
        method: 'GET',
        url: path,
        responseType: 'text',
        transformResponse: (data) => data,
      })
      return res.data
    } catch (err) {
      const axiosErr = err as AxiosError
      if (axiosErr.response) {
        const errorBody =
          typeof axiosErr.response.data === 'string'
            ? axiosErr.response.data
            : JSON.stringify(axiosErr.response.data ?? axiosErr.message)
        throw new BridgeApiError(axiosErr.response.status, errorBody, 'GET', path)
      }
      if (axiosErr.code === 'ECONNABORTED') {
        throw new BridgeApiError(0, 'Request timed out', 'GET', path)
      }
      throw err
    }
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('POST', path, body)
  }

  async patch<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('PATCH', path, body)
  }

  async postPochAttestation(
    portalAddress: string,
    opts?: import('./types').AttestationDepositMeta,
  ): Promise<import('./types').PochAttestationData> {
    return this.post('/api/attestation/poch', { portalAddress, ...opts })
  }

  async postPassportAttestation(
    portalAddress: string,
    bridgeAddress?: string,
    opts?: import('./types').AttestationDepositMeta,
  ): Promise<import('./types').PassportAttestationData> {
    return this.post('/api/attestation/passport', { portalAddress, bridgeAddress, ...opts })
  }

  async getAttestationStatus(): Promise<import('./types').AttestationStatus> {
    return this.get('/api/attestation/status')
  }

  async checkPochEligibility(): Promise<import('./types').PochCheckResult> {
    return this.get('/api/attestation/poch/check')
  }

  async checkPassportEligibility(): Promise<import('./types').PassportCheckResult> {
    return this.get('/api/attestation/passport/check')
  }

  async getL1TokenBalances(address: string, chains: number[]): Promise<import('./types').L1TokenBalance[]> {
    return this.post('/api/alchemy/tokens-balances', { address, chains })
  }

  async mintTestTokens(address: string, tokenAddress: string): Promise<import('./types').MintTokensResult> {
    return this.post('/api/mint-tokens', { address, tokenAddress })
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    try {
      const res = await this.client.request<T>({
        method,
        url: path,
        data: body,
      })
      return res.data
    } catch (err) {
      const axiosErr = err as AxiosError
      if (axiosErr.response) {
        const errorBody =
          typeof axiosErr.response.data === 'string'
            ? axiosErr.response.data
            : JSON.stringify(axiosErr.response.data ?? axiosErr.message)
        throw new BridgeApiError(axiosErr.response.status, errorBody, method, path)
      }
      if (axiosErr.code === 'ECONNABORTED') {
        throw new BridgeApiError(0, `Request timed out`, method, path)
      }
      throw err
    }
  }
}

export class BridgeApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
    public readonly method: string,
    public readonly path: string,
  ) {
    // `message` stays a developer-readable summary — never the raw body.
    // The previous version embedded `body` here, which produced 5KB+ messages
    // when the server returned an HTML error page (Next.js 500). Callers that
    // need the body should read `.body` (raw) or `.parsedBody` (JSON envelope).
    super(`Bridge API ${method} ${path} failed (${status})`)
    this.name = 'BridgeApiError'
  }

  /**
   * Parse `body` as JSON. Returns the parsed object when the response was a
   * JSON envelope (typical shape: `{ error, reason }`), or null when the body
   * was a plain string / non-JSON. Lets callers surface a friendly
   * `reason`/`error` field in toasts instead of the raw stringified body.
   */
  get parsedBody(): Record<string, unknown> | null {
    try {
      const parsed = JSON.parse(this.body)
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
    } catch {
      return null
    }
  }

  /**
   * Best-effort human-readable error string for toasts/banners. Order:
   *   1. JSON `reason` field (most specific, e.g. sanctions reason)
   *   2. JSON `error` field
   *   3. Plain-text body if it's short and not HTML
   *   4. A status-mapped fallback (`Server error (500)`, etc.)
   * Always returns a string short enough for a toast.
   */
  get friendlyMessage(): string {
    const parsed = this.parsedBody
    const fromJson = (parsed?.reason as string | undefined) ?? (parsed?.error as string | undefined)
    if (typeof fromJson === 'string' && fromJson.length > 0) return fromJson

    const trimmed = (this.body ?? '').trim()
    const looksLikeHtml = trimmed.startsWith('<')
    if (!looksLikeHtml && trimmed.length > 0 && trimmed.length <= 200) return trimmed

    if (this.status >= 500) return `Server error (${this.status}). Please try again shortly.`
    if (this.status === 401) return 'Authentication required. Please reconnect your wallets.'
    if (this.status === 403) return 'Request not allowed.'
    if (this.status === 404) return 'Not found.'
    if (this.status === 400) return 'Invalid request.'
    if (this.status === 0) return 'Network error. Please check your connection.'
    return `Request failed (${this.status}).`
  }
}
