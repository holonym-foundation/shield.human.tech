'use client'

import { createAztecNodeClient } from '@aztec/aztec.js/node'
import { L2_NODE_URL } from '@/config'

// In the browser, proxy through our API route to avoid CORS / COEP issues.
// On the server (SSR), call the node directly.
const nodeUrl =
  typeof window !== 'undefined' ? '/api/aztec-node' : L2_NODE_URL

export const aztecNode = createAztecNodeClient(nodeUrl)
