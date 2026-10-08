import { NO_FROM } from "@aztec-labs/aztec.js/account";
import { SponsoredFeePaymentMethod } from "@aztec-labs/aztec.js/fee";
import { SponsoredFPCContractArtifact } from "@aztec-labs/noir-contracts.js/SponsoredFPC";
import { getSponsoredFPCInstance } from "./sponsored_fpc.js";

import { Fr, GrumpkinScalar } from "@aztec-labs/aztec.js/fields";
import { Logger, createLogger } from "@aztec-labs/aztec.js/log";
import { setupWallet } from "./setup_wallet.js";
import { AccountManager } from "@aztec-labs/aztec.js/wallet";
import { EmbeddedWallet } from "@aztec-labs/wallets/embedded";
import { getTimeouts } from "../config/config.js";

export async function deploySchnorrAccount(wallet?: EmbeddedWallet): Promise<AccountManager> {
    let logger: Logger;
    logger = createLogger('aztec:bridge');
    logger.info('👤 Starting Schnorr account deployment...');

    // Reusing one account across runs keeps its L2 balances, so START_AT_TEST / RUN_ONLY can resume
    // the suite at an exit test without redoing the deposits that funded it.
    const { TEST_ACCOUNT_SECRET, TEST_ACCOUNT_SIGNING_KEY, TEST_ACCOUNT_SALT } = process.env;
    const reuse = !!(TEST_ACCOUNT_SECRET && TEST_ACCOUNT_SIGNING_KEY && TEST_ACCOUNT_SALT);
    const secretKey = reuse ? Fr.fromString(TEST_ACCOUNT_SECRET!) : Fr.random();
    const signingKey = reuse ? GrumpkinScalar.fromString(TEST_ACCOUNT_SIGNING_KEY!) : GrumpkinScalar.random();
    const salt = reuse ? Fr.fromString(TEST_ACCOUNT_SALT!) : Fr.random();
    if (reuse) {
        logger.info('🔐 Reusing account keys from TEST_ACCOUNT_SECRET / TEST_ACCOUNT_SIGNING_KEY / TEST_ACCOUNT_SALT');
    } else {
        logger.info('🔐 Generated account keys. Set these in .env to reuse this account on later runs:');
        logger.info(`   TEST_ACCOUNT_SECRET=${secretKey.toString()}`);
        logger.info(`   TEST_ACCOUNT_SIGNING_KEY=${signingKey.toString()}`);
        logger.info(`   TEST_ACCOUNT_SALT=${salt.toString()}`);
    }

    const activeWallet = wallet ?? await setupWallet()
    const account = await activeWallet.createSchnorrAccount(secretKey, salt, signingKey)
    logger.info(`📍 Account address will be: ${account.address}`);

    logger.info('💰 Setting up sponsored fee payment for account deployment...');
    const sponsoredFPC = await getSponsoredFPCInstance();
    await activeWallet.registerContract(sponsoredFPC, SponsoredFPCContractArtifact);
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
