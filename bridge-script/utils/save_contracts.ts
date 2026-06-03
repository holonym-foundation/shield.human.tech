import { writeFileSync, readFileSync, existsSync, mkdirSync, copyFileSync } from 'fs';
import { join, resolve } from 'path';

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

// Source artifact paths (compiled Noir contracts + codegen)
const ARTIFACT_SOURCES = [
  // Token artifact (Wonderland compliant token — from bridge-script codegen)
  { src: resolve('constants', 'aztec', 'artifacts', 'token-Token.json'), dest: 'token-Token.json' },
  // TokenBridge artifact (custom contract — from aztec-contracts build)
  { src: resolve('..', 'aztec-contracts', 'token_bridge', 'target', 'token_bridge_contract-TokenBridge.json'), dest: 'token_bridge_contract-TokenBridge.json' },
  // TokenMinterProxy artifact (custom contract — from aztec-contracts build)
  { src: resolve('..', 'aztec-contracts', 'token_minter_proxy', 'target', 'token_minter_proxy-TokenMinterProxy.json'), dest: 'token_minter_proxy-TokenMinterProxy.json' },
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
  nodeUrl: string;
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
      nodeUrl: params.nodeUrl,
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
 * Bundle all deployments + registry into a single JSON for the frontend.
 * Format: { activeDeploymentId, deployments: DeploymentFile[] }
 */
export function copyToFrontend(): void {
  const registry = loadRegistry();
  if (!registry || registry.deployments.length === 0) {
    console.warn('⚠️  No deployments to copy');
    return;
  }

  const allDeployments: DeploymentFile[] = [];
  for (const entry of registry.deployments) {
    const deployment = readJson<DeploymentFile>(join(DEPLOYMENTS_DIR, entry.file));
    if (deployment) allDeployments.push(deployment);
  }

  const bundle = {
    activeDeploymentId: registry.activeDeploymentId,
    deployments: allDeployments,
  };

  writeJson(FRONTEND_DEPLOYMENTS, bundle);
  console.log(`📋 Synced ${allDeployments.length} deployment(s) to frontend: ${FRONTEND_DEPLOYMENTS}`);

  // Sync contract artifacts to frontend
  ensureDir(FRONTEND_ARTIFACTS_DIR);
  for (const { src, dest } of ARTIFACT_SOURCES) {
    if (existsSync(src)) {
      copyFileSync(src, join(FRONTEND_ARTIFACTS_DIR, dest));
      console.log(`📦 Synced artifact: ${dest}`);
    } else {
      console.warn(`⚠️  Artifact not found, skipping: ${src}`);
    }
  }
}

/**
 * Bundle all deployments + registry into the SDK's contracts/deployments.json.
 *
 * The SDK (`@human.tech/aztec-bridge-sdk`) resolves contract/token addresses for the actual
 * bridge transaction from THIS file — `createConfig(deployment ?? ACTIVE_DEPLOYMENT_ID)`. The
 * frontend imports the SDK as a workspace package, so without this sync the tx path silently
 * falls back to whatever (stale) deployment the SDK was last built with. Keep it in lockstep
 * with copyToFrontend so quoting (frontend bundle) and execution (SDK bundle) agree.
 */
export function copyToSdk(): void {
  const registry = loadRegistry();
  if (!registry || registry.deployments.length === 0) {
    console.warn('⚠️  No deployments to copy to SDK');
    return;
  }

  const allDeployments: DeploymentFile[] = [];
  for (const entry of registry.deployments) {
    const deployment = readJson<DeploymentFile>(join(DEPLOYMENTS_DIR, entry.file));
    if (deployment) allDeployments.push(deployment);
  }

  const bundle = {
    activeDeploymentId: registry.activeDeploymentId,
    deployments: allDeployments,
  };

  writeJson(SDK_DEPLOYMENTS, bundle);
  console.log(`📋 Synced ${allDeployments.length} deployment(s) to SDK: ${SDK_DEPLOYMENTS}`);
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
