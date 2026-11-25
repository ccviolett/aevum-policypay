import { defineChain, type Address } from 'viem';

/**
 * Live verified QDay Aevum Testnet configuration (verified 2026-11-25 against
 * https://qday.io/official-links and live JSON-RPC https://rpc-test.qday.info).
 */
export const AEVUM_CHAIN_ID = 44005 as const;
export const AEVUM_CHAIN_ID_HEX = '0xabe5' as const;
export const AEVUM_RPC_URL = 'https://rpc-test.qday.info' as const;
export const AEVUM_WS_URL = 'wss://rpc-test.qday.info' as const;
export const AEVUM_EXPLORER_URL = 'https://explorer-test.qday.info' as const;
export const AEVUM_FAUCET_URL = 'https://faucet.qday.info/en' as const;

export const LIVE_TUSD8_ADDRESS =
  '0x456569838f1d43009A91ebA4263147Afd7233483' as Address;
export const LIVE_TUSD8_SYMBOL = 'tUSD8' as const;
export const LIVE_TUSD8_DECIMALS = 6 as const;
export const LIVE_FAUCET_CONTRACT =
  '0xE5074CBbd046AFb491EB8692abD6cF7ECCC6dEE5' as Address;

export const qdayAevumTestnet = defineChain({
  id: AEVUM_CHAIN_ID,
  name: 'QDay Aevum Testnet',
  nativeCurrency: {
    name: 'tQDAY',
    symbol: 'tQDAY',
    decimals: 18,
  },
  rpcUrls: {
    default: {
      http: [AEVUM_RPC_URL],
      webSocket: [AEVUM_WS_URL],
    },
  },
  blockExplorers: {
    default: {
      name: 'QDay Aevum Explorer',
      url: AEVUM_EXPLORER_URL,
    },
  },
  testnet: true,
});

export const EIP712_DOMAIN_NAME = 'AevumPolicyPayVault' as const;
export const EIP712_DOMAIN_VERSION = '1' as const;

export const AGENT_PAYMENT_TYPES = {
  AgentPayment: [
    { name: 'sessionId', type: 'uint256' },
    { name: 'recipient', type: 'address' },
    { name: 'amount', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint64' },
    { name: 'memoHash', type: 'bytes32' },
  ],
} as const;

export const AGENT_INVOICE_TYPES = {
  AgentInvoice: [
    { name: 'sessionId', type: 'uint256' },
    { name: 'payee', type: 'address' },
    { name: 'amount', type: 'uint256' },
    { name: 'expiresAt', type: 'uint64' },
    { name: 'confirmationHash', type: 'bytes32' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint64' },
  ],
} as const;

export function explorerTxUrl(txHash: string): string {
  return `${AEVUM_EXPLORER_URL}/tx/${txHash}`;
}

export function explorerAddressUrl(address: string): string {
  return `${AEVUM_EXPLORER_URL}/address/${address}`;
}
