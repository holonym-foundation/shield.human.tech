import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
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
  // Fee infrastructure
  feeAssetHandler: string;
  sponsoredFee: string;
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
  bridgeAndFuelAddress?: string;
  mockFuelSwapAddress?: string;
  tokens: DeployedToken[];
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
const SDK_CONTRACTS_DIR = resolve('..', 'packages', 'sdk', 'src', 'contracts');
const SDK_DEPLOYMENTS = join(SDK_CONTRACTS_DIR, 'deployments.json');
const SDK_ABIS_DIR = join(SDK_CONTRACTS_DIR, 'abis');
const SDK_ARTIFACTS_DIR = join(SDK_CONTRACTS_DIR, 'artifacts');
const L1_OUT = resolve('..', 'l1-contracts', 'out');
const AZTEC_CONTRACTS = resolve('..', 'aztec-contracts');

// L1 Forge build output → SDK ABI JSON mappings
// Each entry: { src: forge JSON path, dest: SDK output path }
const L1_ABI_SOURCES: { src: string; dest: string }[] = [
  {
    src: join(L1_OUT, 'TokenPortal.sol', 'TokenPortal.json'),
    dest: join(SDK_ABIS_DIR, 'TokenPortal.json'),
  },
  {
    src: join(L1_OUT, 'BridgeAndFuel.sol', 'BridgeAndFuel.json'),
    dest: join(SDK_ABIS_DIR, 'BridgeAndFuel.json'),
  },
  {
    src: join(L1_OUT, 'MockFuelSwap.sol', 'MockFuelSwap.json'),
    dest: join(SDK_ABIS_DIR, 'MockFuelSwap.json'),
  },
];

// Aztec (Noir) contract artifacts → SDK
// These are full Noir artifacts (not Solidity ABIs) — copied as-is
const AZTEC_ARTIFACT_SOURCES: { src: string; dest: string }[] = [
  {
    src: join(AZTEC_CONTRACTS, 'token_bridge', 'target', 'token_contract-Token.json'),
    dest: join(SDK_ARTIFACTS_DIR, 'Token.json'),
  },
  {
    src: join(AZTEC_CONTRACTS, 'token_bridge', 'target', 'token_bridge_contract-TokenBridge.json'),
    dest: join(SDK_ARTIFACTS_DIR, 'TokenBridge.json'),
  },
  {
    src: join(AZTEC_CONTRACTS, 'token_minter_proxy', 'target', 'token_minter_proxy-TokenMinterProxy.json'),
    dest: join(SDK_ARTIFACTS_DIR, 'TokenMinterProxy.json'),
  },
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
      l1RpcUrl: params.l1RpcUrl,
      l1ChainId: params.l1ChainId,
      l2ChainId: params.l2ChainId,
      aztecVersion: params.aztecVersion,
      rollupVersion: params.rollupVersion,
    },
    l1ContractAddresses: params.l1ContractAddresses,
    nodeInfo: params.nodeInfo,
    sponsoredFeeAddress: params.sponsoredFeeAddress,
    tokens: existingTokens,
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
 * Save BridgeAndFuel / MockFuelSwap addresses to the active deployment.
 */
export function saveFuelInfraToDeployment(params: {
  bridgeAndFuelAddress: string;
  mockFuelSwapAddress: string;
}, deploymentId?: string): void {
  const id = deploymentId ?? loadRegistry()?.activeDeploymentId;
  if (!id) throw new Error('No active deployment to save fuel infra to');

  const registry = loadRegistry();
  const entry = registry?.deployments.find(d => d.id === id);
  if (!entry) throw new Error(`Deployment ${id} not found in registry`);

  const filePath = join(DEPLOYMENTS_DIR, entry.file);
  const deployment = readJson<DeploymentFile>(filePath);
  if (!deployment) throw new Error(`Deployment file not found: ${filePath}`);

  deployment.bridgeAndFuelAddress = params.bridgeAndFuelAddress;
  deployment.mockFuelSwapAddress = params.mockFuelSwapAddress;

  writeJson(filePath, deployment);
  console.log(`✅ Saved fuel infra to deployment ${id}`);
}

/**
 * Load existing tokens from the active deployment (for skip-if-deployed checks).
 */
export function loadExistingTokens(): DeployedToken[] {
  const deployment = loadActiveDeployment();
  return deployment?.tokens ?? [];
}

/**
 * Copy all deployment data, contract ABIs, and Aztec artifacts to the SDK.
 *
 * - Deployments: bundles all deployment files into packages/sdk/src/deployments.json
 * - L1 ABIs (Forge): extracts `abi` array, strips `internalType` fields
 * - Aztec artifacts (Noir): copies full artifact JSON as-is
 *
 * Call this at the end of a deployment run.
 */
export function copyToSdk(): void {
  // ── Deployments ──
  const registry = loadRegistry();
  if (!registry || registry.deployments.length === 0) {
    console.warn('⚠️  No deployments to copy');
  } else {
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

  // ── L1 Forge ABIs ──
  ensureDir(SDK_CONTRACTS_DIR);
  ensureDir(SDK_ABIS_DIR);
  ensureDir(SDK_ARTIFACTS_DIR);

  // Strip internalType fields — Solidity compiler metadata, not needed at runtime
  const strip = (obj: unknown): unknown => {
    if (Array.isArray(obj)) return obj.map(strip);
    if (obj && typeof obj === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
        if (k !== 'internalType') out[k] = strip(v);
      }
      return out;
    }
    return obj;
  };

  for (const { src, dest } of L1_ABI_SOURCES) {
    if (!existsSync(src)) {
      console.warn(`⚠️  L1 ABI source not found (run forge build?): ${src}`);
      continue;
    }

    const raw = JSON.parse(readFileSync(src, 'utf8'));
    const abi = raw.abi;
    if (!abi) {
      console.warn(`⚠️  No "abi" key in: ${src}`);
      continue;
    }

    writeJson(dest, strip(abi));
    console.log(`✅ Synced L1 ABI: ${src} → ${dest}`);
  }

  // ── Aztec (Noir) artifacts ──
  for (const { src, dest } of AZTEC_ARTIFACT_SOURCES) {
    if (!existsSync(src)) {
      console.warn(`⚠️  Aztec artifact not found (run aztec codegen?): ${src}`);
      continue;
    }

    // Copy as-is — Noir artifacts are consumed whole by the Aztec SDK
    const content = readFileSync(src, 'utf8');
    writeFileSync(dest, content, 'utf8');
    console.log(`✅ Synced Aztec artifact: ${src} → ${dest}`);
  }
}

/** @deprecated Use copyToSdk() instead */
export const copyToFrontend = copyToSdk;
