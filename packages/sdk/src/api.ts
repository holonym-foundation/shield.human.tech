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

  async postPochAttestation(portalAddress: string): Promise<import('./types').PochAttestationData> {
    return this.post('/api/attestation/poch', { portalAddress })
  }

  async postPassportAttestation(portalAddress: string, bridgeAddress?: string): Promise<import('./types').PassportAttestationData> {
    return this.post('/api/attestation/passport', { portalAddress, bridgeAddress })
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
    super(`Bridge API ${method} ${path} failed (${status}): ${body}`)
    this.name = 'BridgeApiError'
  }
}
