'use client'

import { createRpcLimitedAztecNodeClient } from '@human.tech/clean.sdk'
import { L2_NODE_URL } from '@/config'

export const aztecNode = createRpcLimitedAztecNodeClient(L2_NODE_URL)
