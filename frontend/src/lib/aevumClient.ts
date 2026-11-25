import {
  createPublicClient,
  createWalletClient,
  custom,
  erc20Abi,
  formatUnits,
  http,
  type Address,
  type Hex,
} from 'viem';
import {
  AEVUM_CHAIN_ID,
  AEVUM_CHAIN_ID_HEX,
  AEVUM_EXPLORER_URL,
  AEVUM_RPC_URL,
  LIVE_TUSD8_ADDRESS,
  qdayAevumTestnet,
} from '@shared/aevum';
import { AEVUM_POLICY_PAY_VAULT_ABI } from '@shared/generated/AevumPolicyPayVaultAbi';

interface Eip1193Provider {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
}

declare global {
  interface Window {
    ethereum?: Eip1193Provider;
  }
}

export const aevumPublicClient = createPublicClient({
  chain: qdayAevumTestnet,
  transport: http(AEVUM_RPC_URL),
});

export interface LiveAevumTelemetry {
  connected: boolean;
  chainId: number;
  blockNumber: bigint;
  gasPriceGwei: string;
  tokenSymbol: string;
  tokenDecimals: number;
  tokenTotalSupply: string;
  error?: string;
}

export async function fetchLiveAevumTelemetry(): Promise<LiveAevumTelemetry> {
  try {
    const [chainId, blockNumber, gasPrice, tokenSymbol, tokenDecimals, totalSupply] =
      await Promise.all([
        aevumPublicClient.getChainId(),
        aevumPublicClient.getBlockNumber(),
        aevumPublicClient.getGasPrice(),
        aevumPublicClient.readContract({
          address: LIVE_TUSD8_ADDRESS,
          abi: erc20Abi,
          functionName: 'symbol',
        }),
        aevumPublicClient.readContract({
          address: LIVE_TUSD8_ADDRESS,
          abi: erc20Abi,
          functionName: 'decimals',
        }),
        aevumPublicClient.readContract({
          address: LIVE_TUSD8_ADDRESS,
          abi: erc20Abi,
          functionName: 'totalSupply',
        }),
      ]);

    return {
      connected: true,
      chainId,
      blockNumber,
      gasPriceGwei: formatUnits(gasPrice, 9),
      tokenSymbol,
      tokenDecimals,
      tokenTotalSupply: Number(formatUnits(totalSupply, tokenDecimals)).toLocaleString('en-US', {
        maximumFractionDigits: 2,
      }),
    };
  } catch (err) {
    return {
      connected: false,
      chainId: AEVUM_CHAIN_ID,
      blockNumber: 0n,
      gasPriceGwei: '0',
      tokenSymbol: 'tUSD8',
      tokenDecimals: 6,
      tokenTotalSupply: '—',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function connectAevumWallet(): Promise<{
  account: Address;
  tQdayBalance: string;
  tUsd8Balance: string;
}> {
  if (!window.ethereum) {
    throw new Error('No EIP-1193 wallet detected. Install MetaMask or Rabby, or use Sandbox Mode.');
  }

  const accounts = (await window.ethereum.request({
    method: 'eth_requestAccounts',
  })) as Address[];
  if (!accounts || accounts.length === 0) {
    throw new Error('Wallet connection rejected.');
  }

  try {
    await window.ethereum.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: AEVUM_CHAIN_ID_HEX }],
    });
  } catch {
    await window.ethereum.request({
      method: 'wallet_addEthereumChain',
      params: [
        {
          chainId: AEVUM_CHAIN_ID_HEX,
          chainName: 'QDay Aevum Testnet',
          nativeCurrency: { name: 'tQDAY', symbol: 'tQDAY', decimals: 18 },
          rpcUrls: [AEVUM_RPC_URL],
          blockExplorerUrls: [AEVUM_EXPLORER_URL],
        },
      ],
    });
  }

  const account = accounts[0];
  const [nativeBal, tusd8Bal] = await Promise.all([
    aevumPublicClient.getBalance({ address: account }),
    aevumPublicClient.readContract({
      address: LIVE_TUSD8_ADDRESS,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [account],
    }),
  ]);

  return {
    account,
    tQdayBalance: Number(formatUnits(nativeBal, 18)).toFixed(4),
    tUsd8Balance: Number(formatUnits(tusd8Bal, 6)).toFixed(2),
  };
}

export function createBrowserWalletClient(account: Address) {
  if (!window.ethereum) {
    throw new Error('Wallet provider unavailable');
  }
  return createWalletClient({
    account,
    chain: qdayAevumTestnet,
    transport: custom(window.ethereum),
  });
}

export interface LiveVaultSnapshot {
  nextSessionId: bigint;
  nextInvoiceId: bigint;
  totalAvailableLiquidity: bigint;
  totalSessionUnspent: bigint;
  totalEscrowedInvoices: bigint;
  paused: boolean;
  payerAvailable: bigint;
}

export async function readLiveVaultSnapshot(
  vaultAddress: Address,
  payerAddress?: Address
): Promise<LiveVaultSnapshot> {
  const [
    nextSessionId,
    nextInvoiceId,
    totalAvailableLiquidity,
    totalSessionUnspent,
    totalEscrowedInvoices,
    paused,
    payerAvailable,
  ] = await Promise.all([
    aevumPublicClient.readContract({
      address: vaultAddress,
      abi: AEVUM_POLICY_PAY_VAULT_ABI,
      functionName: 'nextSessionId',
    }),
    aevumPublicClient.readContract({
      address: vaultAddress,
      abi: AEVUM_POLICY_PAY_VAULT_ABI,
      functionName: 'nextInvoiceId',
    }),
    aevumPublicClient.readContract({
      address: vaultAddress,
      abi: AEVUM_POLICY_PAY_VAULT_ABI,
      functionName: 'totalAvailableLiquidity',
    }),
    aevumPublicClient.readContract({
      address: vaultAddress,
      abi: AEVUM_POLICY_PAY_VAULT_ABI,
      functionName: 'totalSessionUnspent',
    }),
    aevumPublicClient.readContract({
      address: vaultAddress,
      abi: AEVUM_POLICY_PAY_VAULT_ABI,
      functionName: 'totalEscrowedInvoices',
    }),
    aevumPublicClient.readContract({
      address: vaultAddress,
      abi: AEVUM_POLICY_PAY_VAULT_ABI,
      functionName: 'paused',
    }),
    payerAddress
      ? aevumPublicClient.readContract({
          address: vaultAddress,
          abi: AEVUM_POLICY_PAY_VAULT_ABI,
          functionName: 'availableBalance',
          args: [payerAddress],
        })
      : Promise.resolve(0n),
  ]);

  return {
    nextSessionId,
    nextInvoiceId,
    totalAvailableLiquidity,
    totalSessionUnspent,
    totalEscrowedInvoices,
    paused,
    payerAvailable,
  };
}

export async function liveApproveAndCreateSession(params: {
  account: Address;
  vaultAddress: Address;
  agent: Address;
  perTxLimit: bigint;
  dailyLimit: bigint;
  totalBudget: bigint;
  validUntil: bigint;
  enforceAllowlist: boolean;
  allowlist: Address[];
  label: string;
}): Promise<{ approveTx: Hex; createTx: Hex }> {
  const wallet = createBrowserWalletClient(params.account);
  const approveTx = await wallet.writeContract({
    address: LIVE_TUSD8_ADDRESS,
    abi: erc20Abi,
    functionName: 'approve',
    args: [params.vaultAddress, params.totalBudget],
  });
  await aevumPublicClient.waitForTransactionReceipt({ hash: approveTx });

  const createTx = await wallet.writeContract({
    address: params.vaultAddress,
    abi: AEVUM_POLICY_PAY_VAULT_ABI,
    functionName: 'createSessionWithDeposit',
    args: [
      params.agent,
      params.perTxLimit,
      params.dailyLimit,
      params.totalBudget,
      params.validUntil,
      params.enforceAllowlist,
      params.allowlist,
      params.label,
    ],
  });
  await aevumPublicClient.waitForTransactionReceipt({ hash: createTx });
  return { approveTx, createTx };
}

export async function liveConfirmAndClaimInvoice(params: {
  account: Address;
  vaultAddress: Address;
  invoiceId: bigint;
  confirmationCode: string;
}): Promise<Hex> {
  const wallet = createBrowserWalletClient(params.account);
  const txHash = await wallet.writeContract({
    address: params.vaultAddress,
    abi: AEVUM_POLICY_PAY_VAULT_ABI,
    functionName: 'confirmAndClaimInvoice',
    args: [params.invoiceId, params.confirmationCode],
  });
  await aevumPublicClient.waitForTransactionReceipt({ hash: txHash });
  return txHash;
}
