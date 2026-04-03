import { NO_FROM } from "@aztec/aztec.js/account";
import { SponsoredFeePaymentMethod } from "@aztec/aztec.js/fee";
import { SponsoredFPCContractArtifact } from "@aztec/noir-contracts.js/SponsoredFPC";
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

    // Register SponsoredFPC with PXE before using it
    logger.info('💰 Setting up sponsored fee payment for account deployment...');
    const sponsoredFPC = await getSponsoredFPCInstance();
    const pxe = (activeWallet as any).pxe;
    if (pxe?.registerContract) {
        await pxe.registerContract({ instance: sponsoredFPC, artifact: SponsoredFPCContractArtifact });
    }
    const sponsoredPaymentMethod = new SponsoredFeePaymentMethod(sponsoredFPC.address);
    logger.info('✅ Sponsored fee payment method configured for account deployment');

    // Deploy account using NO_FROM to bypass SchnorrAccount entrypoint simulation bug
    const timeouts = getTimeouts();
    const deployMethod = await account.getDeployMethod();
    try {
        await deployMethod.send({
            from: NO_FROM,
            fee: { paymentMethod: sponsoredPaymentMethod },
            wait: { timeout: timeouts.deployTimeout },
        });
        logger.info('🎉 Schnorr account deployment completed successfully!');
    } catch (error: any) {
        // "Existing nullifier" means account is already deployed — that's fine
        if (String(error).includes('Existing nullifier') || String(error).includes('already deployed')) {
            logger.info('✅ Account already deployed, continuing...');
        } else {
            throw error;
        }
    }

    logger.info(`📋 Account Summary:`);
    logger.info(`   - Address: ${account.address}`);
    logger.info(`   - Fee Payment: Sponsored FPC (${sponsoredFPC.address})`);

    return account;
}
