import { SponsoredFeePaymentMethod } from "@aztec/aztec.js/fee";
import { NO_FROM } from "@aztec/aztec.js/account";
import { getSponsoredFPCInstance } from "./sponsored_fpc.js";

import { Fr, GrumpkinScalar } from "@aztec/aztec.js/fields";
import { Logger, createLogger } from "@aztec/aztec.js/log";
import { setupWallet } from "./setup_wallet.js";
import { AccountManager } from "@aztec/aztec.js/wallet";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import { getTimeouts } from "../config/config.js";

export async function deploySchnorrAccount(wallet?: EmbeddedWallet): Promise<AccountManager> {
    let logger: Logger;
    logger = createLogger('aztec:bridge');
    logger.info('👤 Starting Schnorr account deployment...');

    // Generate account keys
    logger.info('🔐 Generating account keys...');
    let secretKey = Fr.random();
    let signingKey = GrumpkinScalar.random();
    let salt = Fr.random();
    logger.info(`Save the following SECRET and SALT in .env for future use.`);
    logger.info(`🔑 Secret key generated: ${secretKey.toString()}`);
    logger.info(`🖊️ Signing key generated: ${signingKey.toString()}`);
    logger.info(`🧂 Salt generated: ${salt.toString()}`);

    const activeWallet = wallet ?? await setupWallet()
    const account = await activeWallet.createSchnorrAccount(secretKey, salt, signingKey)
    logger.info(`📍 Account address will be: ${account.address}`);

    const deployMethod = await account.getDeployMethod();

    // Setup sponsored FPC (already registered with wallet by caller)
    logger.info('💰 Setting up sponsored fee payment for account deployment...');
    const sponsoredFPC = await getSponsoredFPCInstance();
    const sponsoredPaymentMethod = new SponsoredFeePaymentMethod(sponsoredFPC.address);
    logger.info('✅ Sponsored fee payment method configured for account deployment');

    // Deploy account
    const timeouts = getTimeouts();
    await deployMethod.send({ from: NO_FROM, fee: { paymentMethod: sponsoredPaymentMethod }, wait: { timeout: timeouts.deployTimeout } });

    logger.info('🎉 Schnorr account deployment completed successfully!');
    logger.info(`📋 Account Summary:`);
    logger.info(`   - Address: ${account.address}`);
    logger.info(`   - Fee Payment: Sponsored FPC (${sponsoredFPC.address})`);

    return account;
}
