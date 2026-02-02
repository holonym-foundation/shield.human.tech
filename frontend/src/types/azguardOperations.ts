/**
 * Azguard Wallet Operation Types
 * 
 * Source: https://github.com/AzguardWallet/azguard-wallet-types/blob/main/src/operation.ts
 * 
 * These types are based on the official Azguard Wallet types repository.
 * They define the RPC operations that can be executed with the Azguard Wallet client.
 */

// Note: These types are simplified versions for our use case.
// For complete type definitions, refer to the official repository.

/** CAIP Account format: "aztec:chainId:address" */
export type CaipAccount = string;

/** CAIP Chain format: "aztec:chainId" */
export type CaipChain = string;

/** Operation result wrapper */
export type Result<T> = {
  status: 'ok' | 'error';
  result?: T;
  error?: string;
};

/** Action types for transactions */
export type Action =
  | CallAction
  | EncodedCallAction
  | AddPrivateAuthwitAction
  | AddPublicAuthwitAction;

/** Call action */
export type CallAction = {
  kind: 'call';
  contract: string;
  method: string;
  args: any[];
};

/** Authwit content for a contract call (must include caller for authwit) */
export type CallAuthwitContent = {
  kind: 'call';
  /** Address of the caller (AztecAddress) - the contract authorized to make the call (e.g. bridge) */
  caller: string;
  contract: string;
  method: string;
  args: any[];
};

/** Add private authwit action (for private function calls) */
export type AddPrivateAuthwitAction = {
  kind: 'add_private_authwit';
  content: CallAuthwitContent;
};

/** Add public authwit action (for public function calls like burn_public) */
export type AddPublicAuthwitAction = {
  kind: 'add_public_authwit';
  content: CallAuthwitContent;
};

/** Encoded call action */
export type EncodedCallAction = {
  kind: 'encoded_call';
  contract: string;
  method: string;
  args: string[];
};

/** Operation kind */
export type OperationKind = Operation["kind"];

/** A request to perform some operation */
export type Operation =
  // Azguard interface:
  | GetCompleteAddressOperation
  | RegisterContractOperation
  | RegisterSenderOperation
  | RegisterTokenOperation
  | SendTransactionOperation
  | SimulateTransactionOperation
  | SimulateUtilityOperation
  | SimulateViewsOperation
  // Aztec.js interface:
  | AztecGetContractClassMetadataOperation
  | AztecGetContractMetadataOperation
  | AztecGetPrivateEventsOperation
  | AztecGetChainInfoOperation
  | AztecGetTxReceiptOperation
  | AztecRegisterSenderOperation
  | AztecGetAddressBookOperation
  | AztecRegisterContractOperation
  | AztecSimulateTxOperation
  | AztecSimulateUtilityOperation
  | AztecProfileTxOperation
  | AztecSendTxOperation
  | AztecCreateAuthWitOperation;

/** Operation result */
export type OperationResult =
  // Azguard interface:
  | Result<GetCompleteAddressResult>
  | Result<RegisterContractResult>
  | Result<RegisterSenderResult>
  | Result<RegisterTokenResult>
  | Result<SendTransactionResult>
  | Result<SimulateTransactionResult>
  | Result<SimulateUtilityResult>
  | Result<SimulateViewsResult>
  // Aztec.js interface:
  | Result<AztecGetContractClassMetadataResult>
  | Result<AztecGetContractMetadataResult>
  | Result<AztecGetPrivateEventsResult>
  | Result<AztecGetChainInfoResult>
  | Result<AztecGetTxReceiptResult>
  | Result<AztecRegisterSenderResult>
  | Result<AztecGetAddressBookResult>
  | Result<AztecRegisterContractResult>
  | Result<AztecSimulateTxResult>
  | Result<AztecSimulateUtilityResult>
  | Result<AztecProfileTxResult>
  | Result<AztecSendTxResult>
  | Result<AztecCreateAuthWitResult>;

// ============================================================================
// Azguard Interface Operations
// ============================================================================

/** A request to get complete address of the specified account */
export type GetCompleteAddressOperation = {
  /** Operation kind */
  kind: "get_complete_address";
  /** Account to get complete address of */
  account: CaipAccount;
};

/** A result of the "get_complete_address" operation (CompleteAddress) */
export type GetCompleteAddressResult = unknown;

/** A request to register contract in PXE */
export type RegisterContractOperation = {
  /** Operation kind */
  kind: "register_contract";
  /** Chain to register the contract for */
  chain: CaipChain;
  /** Address of the contract (AztecAddress) */
  address: string;
  /**
   * Contract instance (ContractInstanceWithAddress).
   * If not specified, the wallet will try to fetch it from PXE/node.
   */
  instance?: unknown;
  /**
   * Contract artifact (ContractArtifact).
   * If not specified, the wallet will try to fetch it from PXE/node.
   */
  artifact?: unknown;
};

/** A result of the "register_contract" operation */
export type RegisterContractResult = void;

/** A request to register sender in PXE */
export type RegisterSenderOperation = {
  /** Operation kind */
  kind: "register_sender";
  /** Chain to register the sender for */
  chain: CaipChain;
  /** Address of the sender (AztecAddress) */
  address: string;
};

/** A result of the "register_sender" operation */
export type RegisterSenderResult = void;

/** A request to import the token into the wallet */
export type RegisterTokenOperation = {
  /** Operation kind */
  kind: "register_token";
  /** Address of the account to add the token for */
  account: CaipAccount;
  /** Address of the token contract (AztecAddress) */
  address: string;
};

/** A result of the "register_token" operation */
export type RegisterTokenResult = Result<void>;

/** Fees and gas options */
export type FeeOptions = {
  /** Tells if fee payment payload (either fee juice with claim or fpc) is included */
  readonly embeddedFeePayment?: "fjwc" | "fpc";
  /** Suggest gas limits to be used at the first step of estimation */
  readonly gasLimits?: GasLimits;
  /** Suggest teardown gas limits to be used at the first step of estimation */
  readonly teardownGasLimits?: GasLimits;
  /** Multiplier for the simulated gas */
  readonly gasPadding?: number;
};

/** Gas limits */
export type GasLimits = {
  /** DA gas */
  readonly daGas: number;
  /** L2 gas */
  readonly l2Gas: number;
};

/** A request to send the transaction */
export type SendTransactionOperation = {
  /** Operation kind */
  kind: "send_transaction";
  /** Address of the account to send transaction from */
  account: CaipAccount;
  /**
   * Batch of calls to be passed to the account contract
   * and additional actions, that may be needed for its execution
   * */
  actions: Action[];
  /** Fees and gas options */
  fee?: FeeOptions;
};

/** A result of the "send_transaction" operation (TxHash) */
export type SendTransactionResult = string;

/** A request to simulate the transaction */
export type SimulateTransactionOperation = {
  /** Operation kind */
  kind: "simulate_transaction";
  /** Address of the account to send transaction from */
  account: CaipAccount;
  /**
   * Batch of calls to be passed to the account contract
   * and additional actions, that may be needed for its execution
   * */
  actions: Action[];
  /** Fees and gas options */
  fee?: FeeOptions;
  /** Whether to also simulate enqueued public calls or not */
  simulatePublic?: boolean;
};

/** A result of the "simulate_transaction" operation */
export type SimulateTransactionResult = {
  /** Gas usage info (GasUsed) */
  gasUsed: unknown;
  /** Private return values (NestedProcessReturnValues) */
  privateReturn: unknown;
  /** Public return values (NestedProcessReturnValues[]) */
  publicReturn: unknown[];
};

/** A request to simulate the utility function */
export type SimulateUtilityOperation = {
  /** Operation kind */
  kind: "simulate_utility";
  /** Address of the account to simulate for */
  account: CaipAccount;
  /** Address of the contract (AztecAddress) */
  contract: string;
  /** Name of the function */
  method: string;
  /** Arguments (unencoded) */
  args: any[];
};

/** A result of the "simulate_utility" operation (AbiDecoded) */
export type SimulateUtilityResult = unknown;

/** A request to simulate the batch of view calls */
export type SimulateViewsOperation = {
  /** Operation kind */
  kind: "simulate_views";
  /** Address of the account to simulate for */
  account: CaipAccount;
  /** Batch of view calls to simulate */
  calls: (CallAction | EncodedCallAction)[];
};

/** A result of the "simulate_views" operation */
export type SimulateViewsResult = {
  /** List of results, encoded with function return types ABI (Fr[][]) */
  encoded: string[][];
  /** List of results, decoded with function return types ABI (AbiDecoded[]) */
  decoded: unknown[];
};

// ============================================================================
// Aztec.js Interface Operations
// ============================================================================

/** Aztec.js Wallet request */
export type AztecGetContractClassMetadataOperation = {
  /** Operation kind */
  kind: "aztec_getContractClassMetadata";
  /** Chain to execute request for */
  chain: CaipChain;
  /** Identifier of the class (Fr) */
  id: unknown;
  /** Whether or not to also return contract artifact */
  includeArtifact?: boolean;
};

/** A result of the "aztec_getContractClassMetadata" operation (ContractClassMetadata) */
export type AztecGetContractClassMetadataResult = unknown;

/** Aztec.js Wallet request */
export type AztecGetContractMetadataOperation = {
  /** Operation kind */
  kind: "aztec_getContractMetadata";
  /** Chain to execute request for */
  chain: CaipChain;
  /** The address that the contract instance resides at (AztecAddress) */
  address: unknown;
};

/** A result of the "aztec_getContractMetadata" operation (ContractMetadata) */
export type AztecGetContractMetadataResult = unknown;

/** Aztec.js Wallet request */
export type AztecGetPrivateEventsOperation = {
  /** Operation kind */
  kind: "aztec_getPrivateEvents";
  /** Chain to execute request for */
  chain: CaipChain;
  /** The address of the contract to get events from (AztecAddress) */
  contractAddress: unknown;
  /** Metadata of the event. This should be the class generated from the contract. e.g. Contract.events.Event (EventMetadataDefinition) */
  eventMetadata: unknown;
  /** The block number to search from */
  from: number;
  /** The amount of blocks to search */
  numBlocks: number;
  /** The addresses that decrypted the logs (AztecAddress[]) */
  recipients: unknown[];
};

/** A result of the "aztec_getPrivateEvents" operation (T[]) */
export type AztecGetPrivateEventsResult = unknown;

/** Aztec.js Wallet request */
export type AztecGetChainInfoOperation = {
  /** Operation kind */
  kind: "aztec_getChainInfo";
  /** Chain to execute request for */
  chain: CaipChain;
};

/** A result of the "aztec_getChainInfo" operation (ChainInfo) */
export type AztecGetChainInfoResult = unknown;

/** Aztec.js Wallet request */
export type AztecGetTxReceiptOperation = {
  /** Operation kind */
  kind: "aztec_getTxReceipt";
  /** Chain to execute request for */
  chain: CaipChain;
  /** The transaction hash (TxHash) */
  txHash: unknown;
};

/** A result of the "aztec_getTxReceipt" operation (TxReceipt) */
export type AztecGetTxReceiptResult = unknown;

/** Aztec.js Wallet request */
export type AztecRegisterSenderOperation = {
  /** Operation kind */
  kind: "aztec_registerSender";
  /** Chain to execute request for */
  chain: CaipChain;
  /** Address of the user to add to the address book (AztecAddress) */
  address: unknown;
  /** Optional alias for the sender's address */
  alias?: string;
};

/** A result of the "aztec_registerSender" operation (AztecAddress) */
export type AztecRegisterSenderResult = unknown;

/** Aztec.js Wallet request */
export type AztecGetAddressBookOperation = {
  /** Operation kind */
  kind: "aztec_getAddressBook";
  /** Chain to execute request for */
  chain: CaipChain;
};

/** A result of the "aztec_getAddressBook" operation (Aliased<AztecAddress>[]) */
export type AztecGetAddressBookResult = unknown;

/** Aztec.js Wallet request */
export type AztecRegisterContractOperation = {
  /** Operation kind */
  kind: "aztec_registerContract";
  /** Chain to execute request for */
  chain: CaipChain;
  /** Contract instance (AztecAddress | ContractInstanceWithAddress | ContractInstantiationData | ContractInstanceAndArtifact) */
  instanceData: unknown;
  /** Contract artifact (ContractArtifact) */
  artifact?: unknown;
  /** Secret key (Fr) */
  secretKey?: unknown;
};

/** A result of the "aztec_registerContract" operation (ContractInstanceWithAddress) */
export type AztecRegisterContractResult = unknown;

/** Aztec.js Wallet request */
export type AztecSimulateTxOperation = {
  /** Operation kind */
  kind: "aztec_simulateTx";
  /** Address of the account to simulate transaction from */
  account: CaipAccount;
  /** Payload (ExecutionPayload) */
  exec: unknown;
  /** Options (SimulateOptions) */
  opts: unknown;
};

/** A result of the "aztec_simulateTx" operation (TxSimulationResult) */
export type AztecSimulateTxResult = unknown;

/** Aztec.js Wallet request */
export type AztecSimulateUtilityOperation = {
  /** Operation kind */
  kind: "aztec_simulateUtility";
  /** Address of the account to simulate utility function from */
  account: CaipAccount;
  /** The name of the utility contract function to be called */
  functionName: string;
  /** The arguments to be provided to the function */
  args: any[];
  /** The address of the contract to be called (AztecAddress) */
  to: unknown;
  /** (Optional) The authentication witnesses required for the function call (AuthWitness[]) */
  authwits?: unknown[];
};

/** A result of the "aztec_simulateUtility" operation (UtilitySimulationResult) */
export type AztecSimulateUtilityResult = unknown;

/** Aztec.js Wallet request */
export type AztecProfileTxOperation = {
  /** Operation kind */
  kind: "aztec_profileTx";
  /** Address of the account to profile tx from */
  account: CaipAccount;
  /** Payload (ExecutionPayload) */
  exec: unknown;
  /** Options (ProfileOptions) */
  opts: unknown;
};

/** A result of the "aztec_profileTx" operation (TxProfileResult) */
export type AztecProfileTxResult = unknown;

/** Aztec.js Wallet request */
export type AztecSendTxOperation = {
  /** Operation kind */
  kind: "aztec_sendTx";
  /** Address of the account to send tx from */
  account: CaipAccount;
  /** Payload (ExecutionPayload) */
  exec: unknown;
  /** Options (SendOptions) */
  opts: unknown;
};

/** A result of the "aztec_sendTx" operation (TxHash) */
export type AztecSendTxResult = unknown;

/** Aztec.js Wallet request */
export type AztecCreateAuthWitOperation = {
  /** Operation kind */
  kind: "aztec_createAuthWit";
  /** Address of the account to create authwit for */
  account: CaipAccount;
  /** Intent or message hash (Fr | Buffer<ArrayBuffer> | IntentInnerHash | CallIntent) */
  messageHashOrIntent: unknown;
};

/** A result of the "aztec_createAuthWit" operation (AuthWitness) */
export type AztecCreateAuthWitResult = unknown;

