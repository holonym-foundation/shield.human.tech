'use client'

import { createAztecNodeClient } from '@aztec/aztec.js/node'
import { L2_NODE_URL } from '@/config'

export const aztecNode = createAztecNodeClient(L2_NODE_URL)
