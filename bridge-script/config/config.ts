import * as dotenv from 'dotenv';
import { resolve } from 'path';

// Load .env from bridge-script/ and project root
dotenv.config({ path: resolve(process.cwd(), '.env') });
dotenv.config({ path: resolve(process.cwd(), '..', '.env') });

// ─── Types ──────────────────────────────────────────────────────────

export type Environment = 'sandbox' | 'devnet' | 'testnet' | 'mainnet';

export interface NetworkConfig {
  nodeUrl: string;
  l1RpcUrl: string;
  l1ChainId: number;
}

export interface TimeoutConfig {
  deployTimeout: number;
  txTimeout: number;
  waitTimeout: number;
}

export interface EnvironmentConfig {
  name: string;
  environment: Environment;
  network: NetworkConfig;
  settings: {
    skipSandbox: boolean;
    version: string;
  };
  timeouts: TimeoutConfig;
}

// ─── Environment Resolution ─────────────────────────────────────────

function resolveEnvironment(): Environment {
  const env = process.env.AZTEC_ENV || 'sandbox';
  const valid: Environment[] = ['sandbox', 'devnet', 'testnet', 'mainnet'];
  if (!valid.includes(env as Environment)) {
    throw new Error(`Invalid AZTEC_ENV="${env}". Must be one of: ${valid.join(', ')}`);
  }
  return env as Environment;
}

// ─── Per-Environment Config ─────────────────────────────────────────

function buildConfig(env: Environment): EnvironmentConfig {
  switch (env) {
    case 'sandbox':
      return {
        name: 'sandbox',
        environment: 'sandbox',
        network: {
          nodeUrl: process.env.AZTEC_NODE_SANDBOX || 'http://localhost:8080',
          l1RpcUrl: process.env.L1_RPC_SANDBOX || 'http://localhost:8545',
          l1ChainId: 31337,
        },
        settings: { skipSandbox: false, version: '4.2.0-aztecnr-rc.2' },
        timeouts: { deployTimeout: 120_000, txTimeout: 60_000, waitTimeout: 30_000 },
      };

    case 'devnet':
      return {
        name: 'devnet',
        environment: 'devnet',
        network: {
          nodeUrl: process.env.AZTEC_NODE_DEVNET || 'https://v4-devnet-2.aztec-labs.com',
          l1RpcUrl: process.env.L1_RPC_SEPOLIA || 'https://ethereum-sepolia-rpc.publicnode.com',
          l1ChainId: 11155111,
        },
        settings: { skipSandbox: true, version: '4.0.0-devnet.2-patch.0' },
        timeouts: { deployTimeout: 1_200_000, txTimeout: 180_000, waitTimeout: 60_000 },
      };

    case 'testnet':
      return {
        name: 'testnet',
        environment: 'testnet',
        network: {
          nodeUrl: process.env.AZTEC_NODE_TESTNET || 'https://rpc.testnet.aztec-labs.com',
          l1RpcUrl: process.env.L1_RPC_SEPOLIA || 'https://ethereum-sepolia-rpc.publicnode.com',
          l1ChainId: 11155111,
        },
        settings: { skipSandbox: true, version: '4.2.0-aztecnr-rc.2' },
        timeouts: { deployTimeout: 1_200_000, txTimeout: 180_000, waitTimeout: 60_000 },
      };

    case 'mainnet':
      return {
        name: 'mainnet',
        environment: 'mainnet',
        network: {
          nodeUrl: process.env.AZTEC_NODE_MAINNET || 'https://aztec-mainnet.drpc.org',
          l1RpcUrl: process.env.L1_RPC_MAINNET || 'https://ethereum-rpc.publicnode.com',
          l1ChainId: 1,
        },
        settings: { skipSandbox: true, version: '4.2.0-aztecnr-rc.2' },
        timeouts: { deployTimeout: 1_200_000, txTimeout: 300_000, waitTimeout: 120_000 },
      };
  }
}

// ─── Singleton ──────────────────────────────────────────────────────

export class ConfigManager {
  private static instance: ConfigManager;
  private config: EnvironmentConfig;

  private constructor() {
    const env = resolveEnvironment();
    this.config = buildConfig(env);

    // Allow per-run overrides
    if (process.env.L1_URL) this.config.network.l1RpcUrl = process.env.L1_URL;
    if (process.env.AZTEC_NODE_URL) this.config.network.nodeUrl = process.env.AZTEC_NODE_URL;

    console.log(`[Config] ${this.config.name} | node=${this.config.network.nodeUrl} | l1=${this.config.network.l1RpcUrl} | chainId=${this.config.network.l1ChainId}`);
  }

  public static getInstance(): ConfigManager {
    if (!ConfigManager.instance) {
      ConfigManager.instance = new ConfigManager();
    }
    return ConfigManager.instance;
  }

  public getConfig(): EnvironmentConfig { return this.config; }
  public getNetworkConfig(): NetworkConfig { return this.config.network; }
  public getNodeUrl(): string { return this.config.network.nodeUrl; }
  public getL1RpcUrl(): string { return this.config.network.l1RpcUrl; }
  public getL1ChainId(): number { return this.config.network.l1ChainId; }
  public getTimeouts(): TimeoutConfig { return this.config.timeouts; }

  public isDevnet(): boolean { return this.config.environment === 'devnet'; }
  public isTestnet(): boolean { return this.config.environment === 'testnet'; }
  public isMainnet(): boolean { return this.config.environment === 'mainnet'; }
  public isSandbox(): boolean { return this.config.environment === 'sandbox'; }
}

// ─── Singleton + Convenience Exports ────────────────────────────────

const configManager = ConfigManager.getInstance();

export function getAztecNodeUrl(): string { return configManager.getNodeUrl(); }
export function getL1RpcUrl(): string { return configManager.getL1RpcUrl(); }
export function getL1ChainId(): number { return configManager.getL1ChainId(); }
export function getEnv(): string { return configManager.getConfig().name; }
export function getTimeouts(): TimeoutConfig { return configManager.getTimeouts(); }
export function isDevnet(): boolean { return configManager.isDevnet(); }
export function isTestnet(): boolean { return configManager.isTestnet(); }
export function isMainnet(): boolean { return configManager.isMainnet(); }

export default configManager;
