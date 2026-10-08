import { createAztecNodeClient } from '@aztec-labs/aztec.js/node';
import { makeFetch } from '@aztec-labs/foundation/json-rpc/client';
import { getAztecNodeUrl, getAztecNodeApiKey, getEnv } from '../config/config.js';
import { EmbeddedWallet } from '@aztec-labs/wallets/embedded';

// Some node endpoints (e.g. mainnet.rpc.aztec-labs.com) authenticate via an X-Aztec-API-Key
// header. createAztecNodeClient sends no auth by default, so inject the header when
// AZTEC_NODE_API_KEY is set.
//
// drpc returns two flavours of transient failure under PXE sync load, at two different layers:
//   1. HTTP 429 "Too many request" — defaultFetch classifies any 4xx as a NoRetryError, so the
//      built-in backoff never fires and the sync dies on the first rate-limit.
//   2. HTTP 200 with a JSON-RPC error body ("Temporary internal error. Please retry", code 19)
//      — defaultFetch returns this as success, so the throw happens later in safe_json_rpc_client,
//      out of reach of any fetch-level retry.
// We wrap fetch to retry BOTH with exponential backoff so we can keep using drpc. Only transient
// markers are retried; genuine RPC errors (unknown state, not found, …) still propagate immediately.
const RATE_LIMIT_BACKOFF_MS = [2000, 4000, 8000, 16000, 32000, 60000];

const TRANSIENT = /\b429\b|too many request|rate.?limit|temporary internal error|please retry|try again later/i;

const isTransientError = (err: unknown): boolean => TRANSIENT.test(err instanceof Error ? err.message : String(err));

// A JSON-RPC response is a single object or a batch array; each entry may carry an `error`.
const bodyHasTransientError = (result: { response?: unknown }): boolean => {
    const entries = Array.isArray(result?.response) ? result.response : [result?.response];
    return entries.some((e: any) => e?.error && TRANSIENT.test(e.error.message ?? ''));
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createNode(): ReturnType<typeof createAztecNodeClient> {
    const url = getAztecNodeUrl();
    const apiKey = getAztecNodeApiKey();
    const base = makeFetch([1, 2, 3], false);
    const wrappedFetch: typeof base = async (host, body, extraHeaders = {}, noRetry) => {
        const headers = apiKey ? { ...extraHeaders, 'X-Aztec-API-Key': apiKey } : extraHeaders;
        for (let attempt = 0; ; attempt++) {
            const last = attempt >= RATE_LIMIT_BACKOFF_MS.length;
            try {
                const result = await base(host, body, headers, noRetry);
                if (last || !bodyHasTransientError(result)) return result;
            } catch (err) {
                if (last || !isTransientError(err)) throw err;
            }
            await sleep(RATE_LIMIT_BACKOFF_MS[attempt]);
        }
    };
    // maxBatchSize: drpc's free tier rejects JSON-RPC batches larger than 3 (code 31).
    return createAztecNodeClient(url, { fetch: wrappedFetch, maxBatchSize: 3 });
}

export async function setupWallet(): Promise<EmbeddedWallet> {
    const node = createNode();
    const proverEnabled = getEnv() !== 'sandbox';
    const wallet = await EmbeddedWallet.create(node, { pxeConfig: { proverEnabled } });
    return wallet;
}
