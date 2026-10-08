import { writeFileSync, readFileSync, existsSync, mkdirSync, copyFileSync } from 'fs';
import { join, resolve } from 'path';
import { getEnv, getPublicAztecNodeUrl } from '../config/config.js';

// ─── Interfaces ─────────────────────────────────────────────────────────────

export interface DeployedToken {
  symbol: string;
  decimals: number;
  logo: string;
  // L1 contracts
  l1TokenContract: string;
  l1PortalContract: string;
  // L2 contracts
  l2TokenContract: string;
  l2BridgeContract: string;
  // TokenMinterProxy — burn/mint authority; REQUIRED for L2→L1 withdrawals (Bridge → Proxy → Token).
  l2ProxyContract: string;
  // Fee infrastructure
  feeAssetHandler: string;
  sponsoredFee: string;
  // Migration state: true when deposits are paused on this portal (rollup upgrade window)
  depositsPaused?: boolean;
}

export interface L1ContractAddresses {
  rollupAddress: string;
  registryAddress: string;
  inboxAddress: string;
  outboxAddress: string;
}

export interface DeploymentNetwork {
  name: string;
  nodeUrl: string;
  l1RpcUrl: string;
  l1ChainId: number;
  l2ChainId: number;
  aztecVersion: string;
  rollupVersion: number;
}

export interface DeploymentFile {
  id: string;
  deployedAt: string;
  network: DeploymentNetwork;
  l1ContractAddresses: L1ContractAddresses;
  nodeInfo: Record<string, unknown>;
  sponsoredFeeAddress: string;
  tokens: DeployedToken[];
  // Fuel swap infrastructure
  uniswapFuelSwapAddress?: string;
  swapBridgeRouterAddress?: string;
  bridgedFpcAddress?: string;
}

export interface RegistryEntry {
  id: string;
  file: string;
  deployedAt: string;
  network: string;
  aztecVersion: string;
  active: boolean;
}

export interface DeploymentRegistry {
  activeDeploymentId: string;
  deployments: RegistryEntry[];
}

// ─── Paths ──────────────────────────────────────────────────────────────────

const DEPLOYMENTS_DIR = join('deployments');
const REGISTRY_FILE = join(DEPLOYMENTS_DIR, 'registry.json');
const FRONTEND_DEPLOYMENTS = resolve('..', 'frontend', 'src', 'constants', 'deployments.json');
const SDK_DEPLOYMENTS = resolve('..', 'packages', 'sdk', 'src', 'contracts', 'deployments.json');
const FRONTEND_ARTIFACTS_DIR = resolve('..', 'frontend', 'src', 'constants', 'aztec', 'artifacts');
const SDK_ABIS_DIR = resolve('..', 'packages', 'sdk', 'src', 'contracts', 'abis');

// Source artifact paths (compiled Noir contracts). These two are loaded by the frontend
// (walletAdapters.getContractArtifact) to registerContract on L2 — the Token artifact is pulled
// from the aztec-standards npm package, not from here.
const ARTIFACT_SOURCES = [
  { src: resolve('..', 'aztec-contracts', 'token_bridge', 'target', 'token_bridge_contract-TokenBridge.json'), dest: 'token_bridge_contract-TokenBridge.json' },
  { src: resolve('..', 'aztec-contracts', 'token_minter_proxy', 'target', 'token_minter_proxy-TokenMinterProxy.json'), dest: 'token_minter_proxy-TokenMinterProxy.json' },
];

// L1 ABI paths (Forge build output → SDK). The SDK builds the actual bridge tx from these,
// so they must be resynced whenever the Solidity contracts are rebuilt.
const ABI_SOURCES = [
  { src: resolve('..', 'l1-contracts', 'out', 'TokenPortal.sol', 'TokenPortal.json'), destDir: SDK_ABIS_DIR, dest: 'TokenPortal.json' },
];

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Auto-derive deployment ID from aztec version + date.
 * e.g. "4.0.0-devnet.2-patch.0_2026-02-19"
 */
export function generateDeploymentId(aztecVersion: string): string {
  const date = new Date().toISOString().split('T')[0];
  return `${aztecVersion}_${date}`;
}

function ensureDir(dir: string) {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    console.log(`📁 Created directory: ${dir}`);
  }
}

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(path: string, data: unknown) {
  writeFileSync(path, JSON.stringify(data, null, 2), 'utf8');
}

// ─── Artifact / ABI sync ─────────────────────────────────────────────────────

/**
 * Copy compiled Noir artifacts into the frontend's artifact dir.
 * Shared by the standalone sync script and by copyToFrontend (deploy path).
 */
function syncFrontendArtifacts(): void {
  ensureDir(FRONTEND_ARTIFACTS_DIR);
  for (const { src, dest } of ARTIFACT_SOURCES) {
    if (existsSync(src)) {
      copyFileSync(src, join(FRONTEND_ARTIFACTS_DIR, dest));
      console.log(`📦 Synced artifact → frontend: ${dest}`);
    } else {
      console.warn(`⚠️  Artifact not found, skipping: ${src}`);
    }
  }
}

/**
 * Copy Forge L1 ABIs into the SDK (replaces the standalone `sync:abi` npm script).
 */
function syncSdkAbis(): void {
  for (const { src, destDir, dest } of ABI_SOURCES) {
    if (existsSync(src)) {
      ensureDir(destDir);
      copyFileSync(src, join(destDir, dest));
      console.log(`📦 Synced ABI → SDK: ${dest}`);
    } else {
      console.warn(`⚠️  ABI not found, skipping: ${src}`);
    }
  }
}

/**
 * Single entry point to sync every build output to its consumer: Noir artifacts → frontend,
 * L1 ABIs → SDK. Run after `compile`/`compile:l1`/`codegen` (see the `build` npm script) and
 * standalone via `pnpm run sync:artifacts`.
 */
export function syncArtifacts(): void {
  syncFrontendArtifacts();
  syncSdkAbis();
}

// ─── Registry ───────────────────────────────────────────────────────────────

export function loadRegistry(): DeploymentRegistry | null {
  return readJson<DeploymentRegistry>(REGISTRY_FILE);
}

export function loadActiveDeployment(): DeploymentFile | null {
  const registry = loadRegistry();
  if (!registry?.activeDeploymentId) return null;
  return loadDeploymentById(registry.activeDeploymentId);
}

export function loadDeploymentById(id: string): DeploymentFile | null {
  const registry = loadRegistry();
  const entry = registry?.deployments.find(d => d.id === id);
  if (!entry) return null;
  return readJson<DeploymentFile>(join(DEPLOYMENTS_DIR, entry.file));
}

// ─── Deployment lifecycle ───────────────────────────────────────────────────

/**
 * Create a new deployment file and register it as active.
 * Call this once at the start of a deployment run (before deploying tokens).
 */
export function createDeployment(params: {
  l1RpcUrl: string;
  l1ChainId: number;
  l2ChainId: number;
  aztecVersion: string;
  rollupVersion: number;
  networkName: string;
  l1ContractAddresses: L1ContractAddresses;
  nodeInfo: Record<string, unknown>;
  sponsoredFeeAddress: string;
}): DeploymentFile {
  ensureDir(DEPLOYMENTS_DIR);

  const id = generateDeploymentId(params.aztecVersion);
  const fileName = `${id}.json`;
  const filePath = join(DEPLOYMENTS_DIR, fileName);

  // Preserve existing tokens if re-running with the same deployment ID
  const existing = readJson<DeploymentFile>(filePath);
  const existingTokens = existing?.tokens ?? [];

  const deployment: DeploymentFile = {
    id,
    deployedAt: existing?.deployedAt ?? new Date().toISOString(),
    network: {
      name: params.networkName,
      nodeUrl: getPublicAztecNodeUrl(),
      l1RpcUrl: '', // not saved — frontend uses NEXT_PUBLIC_ETHEREUM_RPC_URL env var
      l1ChainId: params.l1ChainId,
      l2ChainId: params.l2ChainId,
      aztecVersion: params.aztecVersion,
      rollupVersion: params.rollupVersion,
    },
    l1ContractAddresses: params.l1ContractAddresses,
    nodeInfo: params.nodeInfo,
    sponsoredFeeAddress: params.sponsoredFeeAddress,
    tokens: existingTokens,
    // Preserve fuel swap infra addresses across re-runs
    ...(existing?.uniswapFuelSwapAddress && { uniswapFuelSwapAddress: existing.uniswapFuelSwapAddress }),
    ...(existing?.swapBridgeRouterAddress && { swapBridgeRouterAddress: existing.swapBridgeRouterAddress }),
    ...(existing?.bridgedFpcAddress && { bridgedFpcAddress: existing.bridgedFpcAddress }),
  };

  writeJson(filePath, deployment);
  if (existingTokens.length > 0) {
    console.log(`📄 Updated deployment: deployments/${fileName} (preserved ${existingTokens.length} existing tokens)`);
  } else {
    console.log(`📄 Created deployment: deployments/${fileName}`);
  }

  // Update registry
  let registry = loadRegistry() ?? { activeDeploymentId: '', deployments: [] };
  for (const entry of registry.deployments) entry.active = false;

  const existingIdx = registry.deployments.findIndex(d => d.id === id);
  const entry: RegistryEntry = {
    id,
    file: fileName,
    deployedAt: deployment.deployedAt,
    network: params.networkName,
    aztecVersion: params.aztecVersion,
    active: true,
  };
  if (existingIdx >= 0) registry.deployments[existingIdx] = entry;
  else registry.deployments.push(entry);
  registry.activeDeploymentId = id;

  writeJson(REGISTRY_FILE, registry);
  console.log(`📋 Registry updated: active = ${id}`);

  return deployment;
}

/**
 * Add a deployed token to the active deployment file.
 * Call this after each token deploys successfully (incremental save).
 */
export function saveTokenToDeployment(token: DeployedToken, deploymentId?: string): void {
  const id = deploymentId ?? loadRegistry()?.activeDeploymentId;
  if (!id) throw new Error('No active deployment to save token to');

  const registry = loadRegistry();
  const entry = registry?.deployments.find(d => d.id === id);
  if (!entry) throw new Error(`Deployment ${id} not found in registry`);

  const filePath = join(DEPLOYMENTS_DIR, entry.file);
  const deployment = readJson<DeploymentFile>(filePath);
  if (!deployment) throw new Error(`Deployment file not found: ${filePath}`);

  // Replace existing token with same symbol, or append
  deployment.tokens = deployment.tokens.filter(t => t.symbol !== token.symbol);
  deployment.tokens.push(token);

  writeJson(filePath, deployment);
  console.log(`✅ Saved ${token.symbol} to deployment ${id}`);
}

/**
 * Load existing tokens from the active deployment (for skip-if-deployed checks).
 */
export function loadExistingTokens(): DeployedToken[] {
  const deployment = loadActiveDeployment();
  return deployment?.tokens ?? [];
}

/**
 * Build a network-scoped bundle from the registry: only deployments whose network matches
 * `env`, so the testnet site ships only testnet deployments and the mainnet site only
 * mainnet ones (the two branches keep separate, non-overlapping deployment lists).
 *
 * `activeDeploymentId` is the registry's active id if it belongs to this env, otherwise the
 * newest in-env deployment — never an id absent from the bundle.
 */
function buildEnvBundle(env: string): { activeDeploymentId: string; deployments: DeploymentFile[] } | null {
  const registry = loadRegistry();
  if (!registry || registry.deployments.length === 0) return null;

  const inEnv = registry.deployments.filter(
    (e) => String(e.network).toLowerCase() === env.toLowerCase(),
  );

  const deployments: DeploymentFile[] = [];
  for (const entry of inEnv) {
    const deployment = readJson<DeploymentFile>(join(DEPLOYMENTS_DIR, entry.file));
    if (deployment) deployments.push(deployment);
  }

  const activeInEnv = inEnv.some((e) => e.id === registry.activeDeploymentId);
  const newest = [...inEnv].sort((a, b) => b.deployedAt.localeCompare(a.deployedAt))[0];
  const activeDeploymentId = activeInEnv ? registry.activeDeploymentId : (newest?.id ?? '');

  return { activeDeploymentId, deployments };
}

/**
 * Bundle the current environment's deployments into a single JSON for the frontend.
 * Format: { activeDeploymentId, deployments: DeploymentFile[] }
 */
export function copyToFrontend(env: string = getEnv()): void {
  const bundle = buildEnvBundle(env);
  if (!bundle || bundle.deployments.length === 0) {
    console.warn(`⚠️  No ${env} deployments to copy to frontend`);
    return;
  }

  writeJson(FRONTEND_DEPLOYMENTS, bundle);
  console.log(`📋 Synced ${bundle.deployments.length} ${env} deployment(s) to frontend: ${FRONTEND_DEPLOYMENTS}`);

  syncFrontendArtifacts();
}

/**
 * Bundle all deployments + registry into the SDK's contracts/deployments.json.
 *
 * The SDK (`@human.tech/clean.sdk`) resolves contract/token addresses for the actual
 * bridge transaction from THIS file — `createConfig(deployment ?? ACTIVE_DEPLOYMENT_ID)`. The
 * frontend imports the SDK as a workspace package, so without this sync the tx path silently
 * falls back to whatever (stale) deployment the SDK was last built with. Keep it in lockstep
 * with copyToFrontend so quoting (frontend bundle) and execution (SDK bundle) agree.
 */
export function copyToSdk(env: string = getEnv()): void {
  const bundle = buildEnvBundle(env);
  if (!bundle || bundle.deployments.length === 0) {
    console.warn(`⚠️  No ${env} deployments to copy to SDK`);
    return;
  }

  writeJson(SDK_DEPLOYMENTS, bundle);
  console.log(`📋 Synced ${bundle.deployments.length} ${env} deployment(s) to SDK: ${SDK_DEPLOYMENTS}`);
}

/**
 * Save fuel swap infrastructure addresses to the active deployment.
 * These contracts are deployed via Forge scripts (not the TS deployer):
 *   - UniswapFuelSwap: Uniswap V4 swap contract for token→FeeJuice
 *   - SwapBridgeRouter: Permit2-enabled bridge + fuel router
 *   - BridgedFPC: L2 private fee payment contract
 */
export function saveFuelSwapInfraToDeployment(params: {
  uniswapFuelSwapAddress?: string;
  swapBridgeRouterAddress?: string;
  bridgedFpcAddress?: string;
}, deploymentId?: string): void {
  const registry = loadRegistry();
  if (!registry) throw new Error('No registry found');
  const id = deploymentId ?? registry.activeDeploymentId;
  const deployment = loadDeploymentById(id);
  if (!deployment) throw new Error(`Deployment ${id} not found`);

  if (params.uniswapFuelSwapAddress) deployment.uniswapFuelSwapAddress = params.uniswapFuelSwapAddress;
  if (params.swapBridgeRouterAddress) deployment.swapBridgeRouterAddress = params.swapBridgeRouterAddress;
  if (params.bridgedFpcAddress) deployment.bridgedFpcAddress = params.bridgedFpcAddress;

  const filePath = join(DEPLOYMENTS_DIR, `${id}.json`);
  writeJson(filePath, deployment);
  console.log(`✅ Saved fuel swap infra to deployment ${id}`);
}
