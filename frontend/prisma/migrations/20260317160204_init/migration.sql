-- CreateEnum
CREATE TYPE "BridgeDirection" AS ENUM ('L1_TO_L2', 'L2_TO_L1');

-- CreateEnum
CREATE TYPE "BridgeOperationStatus" AS ENUM ('pending', 'deposited', 'claimed', 'submitted', 'ready', 'pending_finalize', 'completed', 'failed');

-- CreateEnum
CREATE TYPE "AttestationType" AS ENUM ('poch', 'passport');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "l1Address" TEXT NOT NULL,
    "l1LoginMethod" TEXT,
    "l1WalletProvider" TEXT,
    "l2Address" TEXT NOT NULL,
    "l2LoginMethod" TEXT,
    "l2WalletProvider" TEXT,
    "defaultPrivacyMode" BOOLEAN,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "address_bindings" (
    "id" TEXT NOT NULL,
    "l1Address" TEXT NOT NULL,
    "l2Address" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "address_bindings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attestation_nonces" (
    "id" TEXT NOT NULL,
    "l1Address" TEXT NOT NULL,
    "type" "AttestationType" NOT NULL,
    "nonce" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "attestation_nonces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bridge_activities" (
    "id" TEXT NOT NULL,
    "fkUserId" TEXT NOT NULL,
    "direction" "BridgeDirection" NOT NULL,
    "status" "BridgeOperationStatus" NOT NULL,
    "encryptedCiphertext" TEXT NOT NULL,
    "encryptedIv" TEXT NOT NULL,
    "encryptedTag" TEXT NOT NULL,
    "keyDerivationMessage" TEXT NOT NULL,
    "keyDerivationDomain" TEXT NOT NULL,
    "recipientL1Address" TEXT,
    "l1TxHash" TEXT,
    "l2TxHash" TEXT,
    "messageHash" TEXT,
    "messageLeafIndex" TEXT,
    "fuelMessageHash" TEXT,
    "fuelMessageLeafIndex" TEXT,
    "fuelAmount" TEXT,
    "l2BlockNumber" TEXT,
    "l2BlockNumberBeforeTx" TEXT,
    "l2ToL1MessageIndex" TEXT,
    "siblingPath" JSONB,
    "l1BlockNumberBeforeTx" TEXT,
    "currentStep" INTEGER DEFAULT 0,
    "completedAt" TIMESTAMP(3),
    "fromNetworkName" TEXT,
    "toNetworkName" TEXT,
    "l1TxUrl" TEXT,
    "l2TxUrl" TEXT,
    "tokenSymbolL1" TEXT,
    "tokenNameL1" TEXT,
    "tokenDecimalsL1" INTEGER,
    "tokenLogoUrlL1" TEXT,
    "tokenAddressL1" TEXT,
    "amountL1" TEXT,
    "amountDisplayL1" TEXT,
    "tokenSymbolL2" TEXT,
    "tokenNameL2" TEXT,
    "tokenDecimalsL2" INTEGER,
    "tokenLogoUrlL2" TEXT,
    "tokenAddressL2" TEXT,
    "amountL2" TEXT,
    "amountDisplayL2" TEXT,
    "tokenSymbol" TEXT,
    "chainIdL1" INTEGER,
    "chainIdL2" INTEGER,
    "isPrivacyModeEnabled" BOOLEAN,
    "portalAddressL1" TEXT,
    "bridgeAddressL2" TEXT,
    "lastErrorMessage" TEXT,
    "nodeInfo" JSONB,
    "rollupVersion" INTEGER,
    "l1InboxAddress" TEXT,
    "l1OutboxAddress" TEXT,
    "l1RollupAddress" TEXT,
    "l1RegistryAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bridge_activities_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_id_key" ON "users"("id");

-- CreateIndex
CREATE INDEX "users_l1Address_idx" ON "users"("l1Address");

-- CreateIndex
CREATE INDEX "users_l2Address_idx" ON "users"("l2Address");

-- CreateIndex
CREATE UNIQUE INDEX "users_l1Address_l2Address_key" ON "users"("l1Address", "l2Address");

-- CreateIndex
CREATE UNIQUE INDEX "address_bindings_l1Address_key" ON "address_bindings"("l1Address");

-- CreateIndex
CREATE UNIQUE INDEX "address_bindings_l2Address_key" ON "address_bindings"("l2Address");

-- CreateIndex
CREATE UNIQUE INDEX "attestation_nonces_l1Address_type_key" ON "attestation_nonces"("l1Address", "type");

-- CreateIndex
CREATE UNIQUE INDEX "bridge_activities_id_key" ON "bridge_activities"("id");

-- CreateIndex
CREATE INDEX "bridge_activities_fkUserId_idx" ON "bridge_activities"("fkUserId");

-- CreateIndex
CREATE INDEX "bridge_activities_fkUserId_createdAt_idx" ON "bridge_activities"("fkUserId", "createdAt");

-- CreateIndex
CREATE INDEX "bridge_activities_status_idx" ON "bridge_activities"("status");

-- CreateIndex
CREATE INDEX "bridge_activities_direction_idx" ON "bridge_activities"("direction");

-- CreateIndex
CREATE INDEX "bridge_activities_l1TxHash_idx" ON "bridge_activities"("l1TxHash");

-- CreateIndex
CREATE INDEX "bridge_activities_l2TxHash_idx" ON "bridge_activities"("l2TxHash");

-- CreateIndex
CREATE INDEX "bridge_activities_createdAt_idx" ON "bridge_activities"("createdAt");

-- CreateIndex
CREATE INDEX "bridge_activities_tokenSymbol_idx" ON "bridge_activities"("tokenSymbol");

-- CreateIndex
CREATE INDEX "bridge_activities_chainIdL1_idx" ON "bridge_activities"("chainIdL1");

-- CreateIndex
CREATE INDEX "bridge_activities_rollupVersion_idx" ON "bridge_activities"("rollupVersion");

-- CreateIndex
CREATE INDEX "bridge_activities_messageHash_idx" ON "bridge_activities"("messageHash");

-- CreateIndex
CREATE INDEX "bridge_activities_l2BlockNumber_idx" ON "bridge_activities"("l2BlockNumber");

-- CreateIndex
CREATE INDEX "bridge_activities_completedAt_idx" ON "bridge_activities"("completedAt");

-- AddForeignKey
ALTER TABLE "bridge_activities" ADD CONSTRAINT "bridge_activities_fkUserId_fkey" FOREIGN KEY ("fkUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
