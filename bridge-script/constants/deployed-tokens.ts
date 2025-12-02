// Auto-generated file - Do not edit manually
// Import deployed tokens from JSON file

import deployedTokensData from './deployed-tokens.json';

export const DEPLOYED_TOKENS = deployedTokensData;

// Helper function to get token by symbol
export function getTokenBySymbol(symbol: string) {
  return deployedTokensData.tokens.find(token => token.symbol === symbol);
}

// Helper function to get all deployed tokens
export function getAllTokens() {
  return deployedTokensData.tokens;
}

export type DeployedToken = typeof deployedTokensData.tokens[0];
