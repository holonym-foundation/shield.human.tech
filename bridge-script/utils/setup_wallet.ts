import { createAztecNodeClient } from '@aztec/aztec.js/node';
import { getAztecNodeUrl, getEnv } from '../config/config.js';
import { EmbeddedWallet } from '@aztec/wallets/embedded';

export async function setupWallet(): Promise<EmbeddedWallet> {
const nodeUrl = getAztecNodeUrl();
const node = createAztecNodeClient(nodeUrl);
const proverEnabled = getEnv() !== 'sandbox';
const wallet = await EmbeddedWallet.create(node, { pxeConfig: { proverEnabled } });
return wallet;
}
