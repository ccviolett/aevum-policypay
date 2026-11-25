import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient,
  createWalletClient,
  encodeDeployData,
  erc20Abi,
  formatEther,
  formatUnits,
  http,
  keccak256,
  parseEther,
  parseUnits,
  stringToHex,
  type Address,
  type Hex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import {
  AEVUM_CHAIN_ID,
  AEVUM_EXPLORER_URL,
  AEVUM_FAUCET_URL,
  AEVUM_RPC_URL,
  AGENT_INVOICE_TYPES,
  AGENT_PAYMENT_TYPES,
  EIP712_DOMAIN_NAME,
  EIP712_DOMAIN_VERSION,
  LIVE_TUSD8_ADDRESS,
  explorerAddressUrl,
  explorerTxUrl,
  qdayAevumTestnet,
} from '../shared/aevum.js';
import {
  AEVUM_POLICY_PAY_VAULT_ABI,
  AEVUM_POLICY_PAY_VAULT_BYTECODE,
} from '../shared/generated/AevumPolicyPayVaultAbi.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

interface ProofStep {
  step: string;
  txHash: Hex;
  gasUsed: string;
  explorer: string;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run') || !process.env.PRIVATE_KEY;

  console.log('=== Aevum PolicyPay — QDay Aevum Testnet Verifier & Deployer ===');
  console.log(`RPC URL:       ${AEVUM_RPC_URL}`);
  console.log(`Expected ID:   ${AEVUM_CHAIN_ID}`);
  console.log(`tUSD8 Token:   ${LIVE_TUSD8_ADDRESS}`);
  console.log(`Mode:          ${dryRun ? 'DRY-RUN (read-only live RPC verification)' : 'LIVE DEPLOY + E2E PROOF'}\n`);

  const publicClient = createPublicClient({
    chain: qdayAevumTestnet,
    transport: http(AEVUM_RPC_URL),
  });

  // 1. Live RPC & Network Verification
  const [chainId, blockNumber, gasPrice] = await Promise.all([
    publicClient.getChainId(),
    publicClient.getBlockNumber(),
    publicClient.getGasPrice(),
  ]);

  if (chainId !== AEVUM_CHAIN_ID) {
    throw new Error(`Unexpected chainId from RPC: got ${chainId}, expected ${AEVUM_CHAIN_ID}`);
  }

  // 2. Live tUSD8 Contract Verification
  const [tokenName, tokenSymbol, tokenDecimals, tokenTotalSupply, tokenCode] = await Promise.all([
    publicClient.readContract({ address: LIVE_TUSD8_ADDRESS, abi: erc20Abi, functionName: 'name' }),
    publicClient.readContract({ address: LIVE_TUSD8_ADDRESS, abi: erc20Abi, functionName: 'symbol' }),
    publicClient.readContract({ address: LIVE_TUSD8_ADDRESS, abi: erc20Abi, functionName: 'decimals' }),
    publicClient.readContract({ address: LIVE_TUSD8_ADDRESS, abi: erc20Abi, functionName: 'totalSupply' }),
    publicClient.getCode({ address: LIVE_TUSD8_ADDRESS }),
  ]);

  if (!tokenCode || tokenCode === '0x') {
    throw new Error(`No bytecode found at tUSD8 address ${LIVE_TUSD8_ADDRESS}`);
  }

  // 3. Live Gas Estimation for AevumPolicyPayVault(LIVE_TUSD8_ADDRESS)
  const deployData = encodeDeployData({
    abi: AEVUM_POLICY_PAY_VAULT_ABI,
    bytecode: AEVUM_POLICY_PAY_VAULT_BYTECODE,
    args: [LIVE_TUSD8_ADDRESS],
  });

  const estimatedDeployGas = await publicClient.estimateGas({
    data: deployData,
  });
  const estimatedDeployCostWei = estimatedDeployGas * gasPrice;

  console.log('Live Aevum Testnet Verification:');
  console.log(`  Chain ID:            ${chainId} (MATCHES QDay Aevum Testnet)`);
  console.log(`  Latest Block:        #${blockNumber.toString()}`);
  console.log(`  Gas Price:           ${formatUnits(gasPrice, 9)} Gwei`);
  console.log(`  tUSD8 Name/Symbol:   ${tokenName} / ${tokenSymbol} (${tokenDecimals} decimals)`);
  console.log(`  tUSD8 Total Supply:  ${formatUnits(tokenTotalSupply, tokenDecimals)} ${tokenSymbol}`);
  console.log(`  tUSD8 Code Size:     ${(tokenCode.length - 2) / 2} bytes`);
  console.log(`  Vault Deploy Gas:    ${estimatedDeployGas.toString()} gas (~${formatEther(estimatedDeployCostWei)} tQDAY)`);

  if (dryRun) {
    console.log('\nDry-run passed against live QDay Aevum Testnet.');
    console.log('To deploy and execute live tUSD8 proof transactions:');
    console.log(`  1. Claim free tQDAY + tUSD8 from ${AEVUM_FAUCET_URL}`);
    console.log('  2. Run: PRIVATE_KEY=0x<your_testnet_key> pnpm deploy:aevum');
    return;
  }

  const rawKey = process.env.PRIVATE_KEY!.trim();
  const deployerKey = (rawKey.startsWith('0x') ? rawKey : `0x${rawKey}`) as Hex;
  const deployer = privateKeyToAccount(deployerKey);

  const walletClient = createWalletClient({
    account: deployer,
    chain: qdayAevumTestnet,
    transport: http(AEVUM_RPC_URL),
  });

  const [nativeBal, tusd8Bal] = await Promise.all([
    publicClient.getBalance({ address: deployer.address }),
    publicClient.readContract({
      address: LIVE_TUSD8_ADDRESS,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [deployer.address],
    }),
  ]);

  console.log(`\nDeployer Address: ${deployer.address}`);
  console.log(`  tQDAY Balance:  ${formatEther(nativeBal)} tQDAY`);
  console.log(`  tUSD8 Balance:  ${formatUnits(tusd8Bal, tokenDecimals)} ${tokenSymbol}`);

  const minGasWei = parseEther('0.05');
  const sessionBudget = parseUnits('3', tokenDecimals); // 3.00 tUSD8 (fits comfortably inside 5 tUSD8 faucet grant!)
  if (nativeBal < minGasWei) {
    throw new Error(
      `Insufficient tQDAY gas (${formatEther(nativeBal)} tQDAY). Claim free tQDAY at ${AEVUM_FAUCET_URL}`
    );
  }
  if (tusd8Bal < sessionBudget) {
    throw new Error(
      `Insufficient tUSD8 (${formatUnits(tusd8Bal, tokenDecimals)} tUSD8; need at least 3 tUSD8). Claim free tUSD8 at ${AEVUM_FAUCET_URL}`
    );
  }

  const proofs: ProofStep[] = [];
  const recordStep = async (step: string, txHash: Hex) => {
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== 'success') {
      throw new Error(`Transaction failed at step "${step}": ${txHash}`);
    }
    proofs.push({
      step,
      txHash,
      gasUsed: receipt.gasUsed.toString(),
      explorer: explorerTxUrl(txHash),
    });
    console.log(`  [OK] ${step}: ${txHash} (gas ${receipt.gasUsed.toString()})`);
    return receipt;
  };

  console.log('\nExecuting live Aevum Testnet E2E deployment & tUSD8 settlement flow...');

  // Step 1: Deploy AevumPolicyPayVault
  const deployHash = await walletClient.deployContract({
    abi: AEVUM_POLICY_PAY_VAULT_ABI,
    bytecode: AEVUM_POLICY_PAY_VAULT_BYTECODE,
    args: [LIVE_TUSD8_ADDRESS],
  });
  const deployReceipt = await recordStep('1. Deploy AevumPolicyPayVault(tUSD8)', deployHash);
  const vaultAddress = deployReceipt.contractAddress as Address;
  if (!vaultAddress) throw new Error('Vault deployment did not return contractAddress');

  // Ephemeral Agent & Payee wallets for live E2E proof
  const agentAccount = privateKeyToAccount(
    (process.env.AGENT_PRIVATE_KEY as Hex | undefined) ?? generatePrivateKey()
  );
  const payeeAccount = privateKeyToAccount(
    (process.env.PAYEE_PRIVATE_KEY as Hex | undefined) ?? generatePrivateKey()
  );

  // Fund payee with 0.01 tQDAY so payee can submit Confirmation-of-Payee claim tx
  const fundPayeeHash = await walletClient.sendTransaction({
    to: payeeAccount.address,
    value: parseEther('0.01'),
  });
  await recordStep('2. Fund Payee Gas (0.01 tQDAY)', fundPayeeHash);

  // Step 3: Approve tUSD8 to Vault
  const approveHash = await walletClient.writeContract({
    address: LIVE_TUSD8_ADDRESS,
    abi: erc20Abi,
    functionName: 'approve',
    args: [vaultAddress, sessionBudget],
  });
  await recordStep('3. Approve 3.00 tUSD8 for Vault', approveHash);

  // Step 4: Create Scoped AI Agent Session with Deposit
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const createSessionHash = await walletClient.writeContract({
    address: vaultAddress,
    abi: AEVUM_POLICY_PAY_VAULT_ABI,
    functionName: 'createSessionWithDeposit',
    args: [
      agentAccount.address,
      parseUnits('1.5', tokenDecimals), // perTxLimit: 1.50 tUSD8
      parseUnits('2.5', tokenDecimals), // dailyLimit: 2.50 tUSD8
      sessionBudget, // totalBudget: 3.00 tUSD8
      nowSec + 7n * 86_400n,
      true,
      [payeeAccount.address],
      'Aevum Autonomous Procurement Agent',
    ],
  });
  await recordStep('4. Create AI Agent Policy Session (3.00 tUSD8)', createSessionHash);

  // Step 5: EIP-712 Signed AI Agent Direct Payment (1.00 tUSD8 -> Payee)
  const memoHash = keccak256(stringToHex('aevum-live-agent-api-settlement-001'));
  const payDeadline = nowSec + 3600n;
  const paySig = await agentAccount.signTypedData({
    domain: {
      name: EIP712_DOMAIN_NAME,
      version: EIP712_DOMAIN_VERSION,
      chainId: AEVUM_CHAIN_ID,
      verifyingContract: vaultAddress,
    },
    types: AGENT_PAYMENT_TYPES,
    primaryType: 'AgentPayment',
    message: {
      sessionId: 1n,
      recipient: payeeAccount.address,
      amount: parseUnits('1', tokenDecimals),
      nonce: 0n,
      deadline: payDeadline,
      memoHash,
    },
  });
  const agentPayHash = await walletClient.writeContract({
    address: vaultAddress,
    abi: AEVUM_POLICY_PAY_VAULT_ABI,
    functionName: 'executeAgentPaymentWithSig',
    args: [1n, payeeAccount.address, parseUnits('1', tokenDecimals), 0n, payDeadline, memoHash, paySig],
  });
  await recordStep('5. Relayed EIP-712 Agent Payment (1.00 tUSD8)', agentPayHash);

  // Step 6: EIP-712 Signed Agent Confirmation-of-Payee Invoice Escrow (1.00 tUSD8)
  const copCode = 'AEVUM-COP-2026-VERIFIED';
  const confirmationHash = await publicClient.readContract({
    address: vaultAddress,
    abi: AEVUM_POLICY_PAY_VAULT_ABI,
    functionName: 'computeConfirmationHash',
    args: [payeeAccount.address, copCode],
  });
  const invoiceExpiresAt = nowSec + 86_400n;
  const invSig = await agentAccount.signTypedData({
    domain: {
      name: EIP712_DOMAIN_NAME,
      version: EIP712_DOMAIN_VERSION,
      chainId: AEVUM_CHAIN_ID,
      verifyingContract: vaultAddress,
    },
    types: AGENT_INVOICE_TYPES,
    primaryType: 'AgentInvoice',
    message: {
      sessionId: 1n,
      payee: payeeAccount.address,
      amount: parseUnits('1', tokenDecimals),
      expiresAt: invoiceExpiresAt,
      confirmationHash,
      nonce: 1n,
      deadline: payDeadline,
    },
  });
  const createInvoiceHash = await walletClient.writeContract({
    address: vaultAddress,
    abi: AEVUM_POLICY_PAY_VAULT_ABI,
    functionName: 'createInvoiceByAgentWithSig',
    args: [
      1n,
      payeeAccount.address,
      parseUnits('1', tokenDecimals),
      invoiceExpiresAt,
      confirmationHash,
      'https://qday.io/builder-challenge#inv-001',
      1n,
      payDeadline,
      invSig,
    ],
  });
  await recordStep('6. Stage CoP Escrow Invoice via Agent Sig (1.00 tUSD8)', createInvoiceHash);

  // Step 7: Payee Confirms Identity + Reference Code and Claims Escrow
  const payeeWallet = createWalletClient({
    account: payeeAccount,
    chain: qdayAevumTestnet,
    transport: http(AEVUM_RPC_URL),
  });
  const claimHash = await payeeWallet.writeContract({
    address: vaultAddress,
    abi: AEVUM_POLICY_PAY_VAULT_ABI,
    functionName: 'confirmAndClaimInvoice',
    args: [1n, copCode],
  });
  await recordStep('7. Payee Confirmation-of-Payee Claim (1.00 tUSD8)', claimHash);

  // Step 8: Revoke Session & Reclaim Remaining 1.00 tUSD8
  const revokeHash = await walletClient.writeContract({
    address: vaultAddress,
    abi: AEVUM_POLICY_PAY_VAULT_ABI,
    functionName: 'revokeSessionAndWithdraw',
    args: [1n],
  });
  await recordStep('8. Revoke Session & Reclaim Unspent 1.00 tUSD8', revokeHash);

  // Save proof artifacts
  const proofJson = {
    network: 'QDay Aevum Testnet',
    chainId: AEVUM_CHAIN_ID,
    rpcUrl: AEVUM_RPC_URL,
    explorerUrl: AEVUM_EXPLORER_URL,
    tUSD8: LIVE_TUSD8_ADDRESS,
    vaultAddress,
    vaultExplorerUrl: explorerAddressUrl(vaultAddress),
    deployer: deployer.address,
    agentAddress: agentAccount.address,
    payeeAddress: payeeAccount.address,
    timestampUtc: new Date().toISOString(),
    transactions: proofs,
  };
  fs.writeFileSync(path.join(ROOT, 'deployment-proof.json'), JSON.stringify(proofJson, null, 2) + '\n');

  const mdLines = [
    '# QDay Aevum Testnet Deployment & E2E Proof',
    '',
    `- **Network**: QDay Aevum Testnet (Chain ID \`${AEVUM_CHAIN_ID}\`)`,
    `- **Vault Contract**: [\`${vaultAddress}\`](${explorerAddressUrl(vaultAddress)})`,
    `- **Live tUSD8 Token**: [\`${LIVE_TUSD8_ADDRESS}\`](${explorerAddressUrl(LIVE_TUSD8_ADDRESS)})`,
    `- **Deployer**: \`${deployer.address}\``,
    `- **AI Agent Signer**: \`${agentAccount.address}\``,
    `- **Verified Payee**: \`${payeeAccount.address}\``,
    '',
    '| Step | Transaction Hash | Gas Used | Aevum Explorer |',
    '| --- | --- | ---: | --- |',
    ...proofs.map((p) => `| ${p.step} | \`${p.txHash}\` | ${p.gasUsed} | [View Tx](${p.explorer}) |`),
    '',
    'To wire the web UI directly to this deployed contract:',
    '```bash',
    `VITE_VAULT_ADDRESS=${vaultAddress} pnpm dev`,
    '```',
    '',
  ];
  fs.writeFileSync(path.join(ROOT, 'DEPLOYMENT_RECEIPT.md'), mdLines.join('\n'));

  console.log('\n=== LIVE AEVUM DEPLOYMENT COMPLETE ===');
  console.log(`Vault Address: ${vaultAddress}`);
  console.log(`Explorer:      ${explorerAddressUrl(vaultAddress)}`);
  console.log('Saved proof table to DEPLOYMENT_RECEIPT.md and deployment-proof.json');
}

main().catch((err) => {
  console.error('\n[ERROR]', err instanceof Error ? err.message : err);
  process.exit(1);
});
