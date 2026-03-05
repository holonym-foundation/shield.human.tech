import { NextRequest, NextResponse } from 'next/server'
import { L2_NODE_URL } from '@/config'

/**
 * Server-side proxy for Aztec node JSON-RPC calls.
 *
 * Avoids browser CORS / Cross-Origin-Embedder-Policy issues that arise
 * when the page is cross-origin-isolated (required for SharedArrayBuffer / WASM).
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.text()

    const response = await fetch(L2_NODE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    })

    const data = await response.text()
    return new NextResponse(data, {
      status: response.status,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (error) {
    console.error('[aztec-node proxy] Error:', error)
    return NextResponse.json(
      { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Proxy fetch failed' } },
      { status: 502 },
    )
  }
}
