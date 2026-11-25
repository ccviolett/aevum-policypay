import { describe, expect, it } from 'vitest';
import { keccak256, parseUnits, stringToHex, type Address, type Hex } from 'viem';
import {
  AEVUM_CHAIN_ID,
  AGENT_INVOICE_TYPES,
  AGENT_PAYMENT_TYPES,
  EIP712_DOMAIN_NAME,
  EIP712_DOMAIN_VERSION,
} from '../shared/aevum.js';
import { loadArtifact, LocalAevumEvm, makeActor, type TestActor } from './evmHarness.js';

const u6 = (amount: string) => parseUnits(amount, 6);

const OWNER = makeActor(
  'owner',
  '0x1000000000000000000000000000000000000000000000000000000000000001'
);
const PAYER = makeActor(
  'payer',
  '0x1000000000000000000000000000000000000000000000000000000000000002'
);
const AGENT = makeActor(
  'agent',
  '0x1000000000000000000000000000000000000000000000000000000000000003'
);
const VENDOR_A = makeActor(
  'vendorA',
  '0x1000000000000000000000000000000000000000000000000000000000000004'
);
const VENDOR_B = makeActor(
  'vendorB',
  '0x1000000000000000000000000000000000000000000000000000000000000005'
);
const RELAYER = makeActor(
  'relayer',
  '0x1000000000000000000000000000000000000000000000000000000000000006'
);
const ATTACKER = makeActor(
  'attacker',
  '0x1000000000000000000000000000000000000000000000000000000000000007'
);

const ALL_ACTORS: TestActor[] = [OWNER, PAYER, AGENT, VENDOR_A, VENDOR_B, RELAYER, ATTACKER];

const tokenArtifact = loadArtifact('MockTUSD8');
const vaultArtifact = loadArtifact('AevumPolicyPayVault');

async function setupFixture() {
  const evm = await LocalAevumEvm.create(ALL_ACTORS);
  const { address: token } = await evm.deploy(OWNER, tokenArtifact);
  const { address: vault } = await evm.deploy(OWNER, vaultArtifact, [token]);

  // Mint 10,000 tUSD8 to PAYER and approve vault
  const initialMint = u6('10000');
  await evm.write(OWNER, token, tokenArtifact.abi, 'mint', [PAYER.address, initialMint]);
  await evm.write(PAYER, token, tokenArtifact.abi, 'approve', [vault, initialMint]);

  const tokenBalanceOf = (addr: Address) =>
    evm.read<bigint>(token, tokenArtifact.abi, 'balanceOf', [addr]);

  const assertSolvencyInvariant = async (expectedTotalSupply: bigint) => {
    const vaultBal = await tokenBalanceOf(vault);
    const avail = await evm.read<bigint>(vault, vaultArtifact.abi, 'totalAvailableLiquidity');
    const sess = await evm.read<bigint>(vault, vaultArtifact.abi, 'totalSessionUnspent');
    const esc = await evm.read<bigint>(vault, vaultArtifact.abi, 'totalEscrowedInvoices');
    const tracked = await evm.read<bigint>(vault, vaultArtifact.abi, 'totalTrackedLiabilities');

    expect(tracked).toBe(avail + sess + esc);
    expect(vaultBal).toBe(tracked);

    let sumActors = 0n;
    for (const actor of ALL_ACTORS) {
      sumActors += await tokenBalanceOf(actor.address);
    }
    expect(sumActors + vaultBal).toBe(expectedTotalSupply);
  };

  return { evm, token, vault, initialMint, tokenBalanceOf, assertSolvencyInvariant };
}

async function signAgentPayment(
  signer: TestActor,
  vault: Address,
  message: {
    sessionId: bigint;
    recipient: Address;
    amount: bigint;
    nonce: bigint;
    deadline: bigint;
    memoHash: Hex;
  }
): Promise<Hex> {
  return signer.account.signTypedData({
    domain: {
      name: EIP712_DOMAIN_NAME,
      version: EIP712_DOMAIN_VERSION,
      chainId: AEVUM_CHAIN_ID,
      verifyingContract: vault,
    },
    types: AGENT_PAYMENT_TYPES,
    primaryType: 'AgentPayment',
    message,
  });
}

async function signAgentInvoice(
  signer: TestActor,
  vault: Address,
  message: {
    sessionId: bigint;
    payee: Address;
    amount: bigint;
    expiresAt: bigint;
    confirmationHash: Hex;
    nonce: bigint;
    deadline: bigint;
  }
): Promise<Hex> {
  return signer.account.signTypedData({
    domain: {
      name: EIP712_DOMAIN_NAME,
      version: EIP712_DOMAIN_VERSION,
      chainId: AEVUM_CHAIN_ID,
      verifyingContract: vault,
    },
    types: AGENT_INVOICE_TYPES,
    primaryType: 'AgentInvoice',
    message,
  });
}

describe('AevumPolicyPayVault (QDay Aevum Chain ID 44005 / Shanghai EVM)', () => {
  it('validates constructor arguments and binds token + Chain ID 44005 EIP-712 domain', async () => {
    const evm = await LocalAevumEvm.create(ALL_ACTORS);
    await evm.expectRevert(
      () => evm.deploy(OWNER, vaultArtifact, ['0x0000000000000000000000000000000000000000']),
      'ZeroAddress'
    );
    await evm.expectRevert(
      () => evm.deploy(OWNER, vaultArtifact, [ATTACKER.address]),
      'InvalidTokenContract'
    );

    const { address: token } = await evm.deploy(OWNER, tokenArtifact);
    const { address: vault } = await evm.deploy(OWNER, vaultArtifact, [token]);

    expect((await evm.read<Address>(vault, vaultArtifact.abi, 'token')).toLowerCase()).toBe(
      token.toLowerCase()
    );
    expect((await evm.read<Address>(vault, vaultArtifact.abi, 'owner')).toLowerCase()).toBe(
      OWNER.address.toLowerCase()
    );
    const domainSep = await evm.read<Hex>(vault, vaultArtifact.abi, 'DOMAIN_SEPARATOR');
    expect(domainSep).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('handles happy-path direct agent payment and enforces per-tx cap strictly', async () => {
    const { evm, vault, initialMint, tokenBalanceOf, assertSolvencyInvariant } = await setupFixture();
    const validUntil = evm.timestamp + 7n * 86_400n;

    const createReceipt = await evm.write(PAYER, vault, vaultArtifact.abi, 'createSessionWithDeposit', [
      AGENT.address,
      u6('25'), // perTxLimit
      u6('60'), // dailyLimit
      u6('200'), // totalBudget
      validUntil,
      true, // enforceAllowlist
      [VENDOR_A.address],
      'Ops API Procurement Agent',
    ]);
    expect(createReceipt.logs.some((l) => l.eventName === 'SessionCreated')).toBe(true);

    // Exact perTxLimit succeeds
    const memo = keccak256(stringToHex('compute-usage-inv-001'));
    const payReceipt = await evm.write(AGENT, vault, vaultArtifact.abi, 'executeAgentPayment', [
      1n,
      VENDOR_A.address,
      u6('25'),
      0n,
      memo,
    ]);
    expect(payReceipt.logs.some((l) => l.eventName === 'AgentPaymentExecuted')).toBe(true);
    expect(await tokenBalanceOf(VENDOR_A.address)).toBe(u6('25'));

    // Per-tx cap + 1 micro-unit (0.000001 tUSD8) MUST revert
    await evm.expectRevert(
      () =>
        evm.write(AGENT, vault, vaultArtifact.abi, 'executeAgentPayment', [
          1n,
          VENDOR_A.address,
          u6('25') + 1n,
          1n,
          memo,
        ]),
      'PerTxLimitExceeded'
    );

    // Non-agent caller MUST revert
    await evm.expectRevert(
      () =>
        evm.write(ATTACKER, vault, vaultArtifact.abi, 'executeAgentPayment', [
          1n,
          VENDOR_A.address,
          u6('5'),
          1n,
          memo,
        ]),
      'Unauthorized'
    );

    await assertSolvencyInvariant(initialMint);
  });

  it('enforces rolling 24h daily limit across hours and resets only after 24h roll-off', async () => {
    const { evm, vault, initialMint, tokenBalanceOf, assertSolvencyInvariant } = await setupFixture();
    const validUntil = evm.timestamp + 14n * 86_400n;

    await evm.write(PAYER, vault, vaultArtifact.abi, 'createSessionWithDeposit', [
      AGENT.address,
      u6('30'), // perTxLimit
      u6('50'), // dailyLimit
      u6('200'), // totalBudget
      validUntil,
      false,
      [],
      'Daily Rolling Window Agent',
    ]);

    const memo = keccak256(stringToHex('daily-batch'));

    // T = 0h: spend 30 tUSD8 (rolling 24h = 30)
    await evm.write(AGENT, vault, vaultArtifact.abi, 'executeAgentPayment', [
      1n,
      VENDOR_A.address,
      u6('30'),
      0n,
      memo,
    ]);

    // T = +12h: spend 20 tUSD8 (rolling 24h = 50 -> exact cap!)
    evm.advanceTime(12n * 3600n);
    await evm.write(AGENT, vault, vaultArtifact.abi, 'executeAgentPayment', [
      1n,
      VENDOR_A.address,
      u6('20'),
      1n,
      memo,
    ]);

    // T = +23h from start (+11h more): STILL inside rolling 24h window -> even 0.000001 MUST revert!
    evm.advanceTime(11n * 3600n);
    expect(await evm.read<bigint>(vault, vaultArtifact.abi, 'getRolling24hSpent', [1n])).toBe(u6('50'));
    await evm.expectRevert(
      () =>
        evm.write(AGENT, vault, vaultArtifact.abi, 'executeAgentPayment', [
          1n,
          VENDOR_A.address,
          1n,
          2n,
          memo,
        ]),
      'DailyLimitExceeded'
    );

    // T = +24h from start (+1h more): the T=0h spend of 30 tUSD8 rolls off, while T=12h spend of 20 remains!
    evm.advanceTime(3600n);
    expect(await evm.read<bigint>(vault, vaultArtifact.abi, 'getRolling24hSpent', [1n])).toBe(u6('20'));

    // 31 tUSD8 would make rolling 24h = 51 -> MUST revert! (Wait: perTxLimit is 30, so test 20 + 11 via two txs)
    await evm.write(AGENT, vault, vaultArtifact.abi, 'executeAgentPayment', [
      1n,
      VENDOR_A.address,
      u6('30'),
      2n,
      memo,
    ]);
    await evm.expectRevert(
      () =>
        evm.write(AGENT, vault, vaultArtifact.abi, 'executeAgentPayment', [
          1n,
          VENDOR_A.address,
          1n,
          3n,
          memo,
        ]),
      'DailyLimitExceeded'
    );

    // Advance another 24h -> full daily reset
    evm.advanceTime(24n * 3600n);
    expect(await evm.read<bigint>(vault, vaultArtifact.abi, 'getRolling24hSpent', [1n])).toBe(0n);
    await evm.write(AGENT, vault, vaultArtifact.abi, 'executeAgentPayment', [
      1n,
      VENDOR_A.address,
      u6('25'),
      3n,
      memo,
    ]);

    expect(await tokenBalanceOf(VENDOR_A.address)).toBe(u6('105'));
    await assertSolvencyInvariant(initialMint);
  });

  it('supports gasless relayed EIP-712 signatures and blocks replay, tampering, expiry, and malleability', async () => {
    const { evm, vault, initialMint, tokenBalanceOf, assertSolvencyInvariant } = await setupFixture();
    const validUntil = evm.timestamp + 3n * 86_400n;

    await evm.write(PAYER, vault, vaultArtifact.abi, 'createSessionWithDeposit', [
      AGENT.address,
      u6('40'),
      u6('100'),
      u6('100'),
      validUntil,
      true,
      [VENDOR_A.address],
      'Gasless EIP-712 Agent',
    ]);

    const memo = keccak256(stringToHex('eip712-relayed-payment'));
    const deadline = evm.timestamp + 3600n;
    const sig0 = await signAgentPayment(AGENT, vault, {
      sessionId: 1n,
      recipient: VENDOR_A.address,
      amount: u6('15'),
      nonce: 0n,
      deadline,
      memoHash: memo,
    });

    // Tampered amount with valid signature MUST fail signature recovery
    await evm.expectRevert(
      () =>
        evm.write(RELAYER, vault, vaultArtifact.abi, 'executeAgentPaymentWithSig', [
          1n,
          VENDOR_A.address,
          u6('16'),
          0n,
          deadline,
          memo,
          sig0,
        ]),
      'InvalidSignature'
    );

    // Wrong signer MUST fail
    const attackerSig = await signAgentPayment(ATTACKER, vault, {
      sessionId: 1n,
      recipient: VENDOR_A.address,
      amount: u6('15'),
      nonce: 0n,
      deadline,
      memoHash: memo,
    });
    await evm.expectRevert(
      () =>
        evm.write(RELAYER, vault, vaultArtifact.abi, 'executeAgentPaymentWithSig', [
          1n,
          VENDOR_A.address,
          u6('15'),
          0n,
          deadline,
          memo,
          attackerSig,
        ]),
      'InvalidSignature'
    );

    // Relayer submits authentic EIP-712 agent signature
    const receipt = await evm.write(RELAYER, vault, vaultArtifact.abi, 'executeAgentPaymentWithSig', [
      1n,
      VENDOR_A.address,
      u6('15'),
      0n,
      deadline,
      memo,
      sig0,
    ]);
    const execLog = receipt.logs.find((l) => l.eventName === 'AgentPaymentExecuted');
    expect(execLog?.args.viaSignature).toBe(true);
    expect(await tokenBalanceOf(VENDOR_A.address)).toBe(u6('15'));

    // Exact replay with same nonce MUST revert InvalidNonce
    await evm.expectRevert(
      () =>
        evm.write(RELAYER, vault, vaultArtifact.abi, 'executeAgentPaymentWithSig', [
          1n,
          VENDOR_A.address,
          u6('15'),
          0n,
          deadline,
          memo,
          sig0,
        ]),
      'InvalidNonce'
    );

    // Skipping nonce (e.g. nonce 2 when expected is 1) MUST revert InvalidNonce
    const skippedSig = await signAgentPayment(AGENT, vault, {
      sessionId: 1n,
      recipient: VENDOR_A.address,
      amount: u6('10'),
      nonce: 2n,
      deadline,
      memoHash: memo,
    });
    await evm.expectRevert(
      () =>
        evm.write(RELAYER, vault, vaultArtifact.abi, 'executeAgentPaymentWithSig', [
          1n,
          VENDOR_A.address,
          u6('10'),
          2n,
          deadline,
          memo,
          skippedSig,
        ]),
      'InvalidNonce'
    );

    // Expired signature deadline MUST revert SignatureExpired
    evm.advanceTime(3601n);
    const expiredSig = await signAgentPayment(AGENT, vault, {
      sessionId: 1n,
      recipient: VENDOR_A.address,
      amount: u6('10'),
      nonce: 1n,
      deadline,
      memoHash: memo,
    });
    await evm.expectRevert(
      () =>
        evm.write(RELAYER, vault, vaultArtifact.abi, 'executeAgentPaymentWithSig', [
          1n,
          VENDOR_A.address,
          u6('10'),
          1n,
          deadline,
          memo,
          expiredSig,
        ]),
      'SignatureExpired'
    );

    // High-s malleable ECDSA signature MUST revert InvalidSignature
    const freshDeadline = evm.timestamp + 3600n;
    const validSig1 = await signAgentPayment(AGENT, vault, {
      sessionId: 1n,
      recipient: VENDOR_A.address,
      amount: u6('10'),
      nonce: 1n,
      deadline: freshDeadline,
      memoHash: memo,
    });
    const secp256k1N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const rHex = validSig1.slice(2, 66);
    const sVal = BigInt(`0x${validSig1.slice(66, 130)}`);
    const vVal = parseInt(validSig1.slice(130, 132), 16);
    const malleatedS = (secp256k1N - sVal).toString(16).padStart(64, '0');
    const flippedV = (vVal === 27 ? 28 : 27).toString(16).padStart(2, '0');
    const malleableSig = `0x${rHex}${malleatedS}${flippedV}` as Hex;
    await evm.expectRevert(
      () =>
        evm.write(RELAYER, vault, vaultArtifact.abi, 'executeAgentPaymentWithSig', [
          1n,
          VENDOR_A.address,
          u6('10'),
          1n,
          freshDeadline,
          memo,
          malleableSig,
        ]),
      'InvalidSignature'
    );

    await assertSolvencyInvariant(initialMint);
  });

  it('enforces total budget exhaustion, topUpSession recovery, getSessionRemainingAllowance, and revokeSessionAndWithdraw', async () => {
    const { evm, vault, initialMint, tokenBalanceOf, assertSolvencyInvariant } = await setupFixture();
    await evm.write(PAYER, vault, vaultArtifact.abi, 'deposit', [u6('100')]);
    const validUntil = evm.timestamp + 86_400n;

    await evm.write(PAYER, vault, vaultArtifact.abi, 'createSession', [
      AGENT.address,
      u6('20'), // perTxLimit
      u6('40'), // dailyLimit
      u6('30'), // totalBudget (smaller than dailyLimit!)
      validUntil,
      false,
      [],
      'Budget-Capped Pilot Agent',
    ]);

    const memo = keccak256(stringToHex('budget-test'));
    await evm.write(AGENT, vault, vaultArtifact.abi, 'executeAgentPayment', [
      1n,
      VENDOR_A.address,
      u6('20'),
      0n,
      memo,
    ]);

    const [remTotal, remDaily, maxNext] = await evm.read<[bigint, bigint, bigint]>(
      vault,
      vaultArtifact.abi,
      'getSessionRemainingAllowance',
      [1n]
    );
    expect(remTotal).toBe(u6('10'));
    expect(remDaily).toBe(u6('20'));
    expect(maxNext).toBe(u6('10'));

    // Spending 11 tUSD8 exceeds remaining totalBudget (10) -> reverts BudgetExceeded
    await evm.expectRevert(
      () =>
        evm.write(AGENT, vault, vaultArtifact.abi, 'executeAgentPayment', [
          1n,
          VENDOR_A.address,
          u6('11'),
          1n,
          memo,
        ]),
      'BudgetExceeded'
    );

    // Top up +25 tUSD8 from availableBalance -> now remainingTotal = 35, remainingDaily = 20, maxNext = 20
    await evm.write(PAYER, vault, vaultArtifact.abi, 'topUpSession', [1n, u6('25')]);
    await evm.write(AGENT, vault, vaultArtifact.abi, 'executeAgentPayment', [
      1n,
      VENDOR_A.address,
      u6('15'),
      1n,
      memo,
    ]);

    // Revoke and withdraw unspent 20 tUSD8 directly back to payer wallet
    const payerBefore = await tokenBalanceOf(PAYER.address);
    await evm.write(PAYER, vault, vaultArtifact.abi, 'revokeSessionAndWithdraw', [1n]);
    expect(await tokenBalanceOf(PAYER.address)).toBe(payerBefore + u6('20'));

    // Remaining allowance for inactive session must report (0, 0, 0)
    const afterRevoke = await evm.read<[bigint, bigint, bigint]>(
      vault,
      vaultArtifact.abi,
      'getSessionRemainingAllowance',
      [1n]
    );
    expect(afterRevoke).toEqual([0n, 0n, 0n]);

    await assertSolvencyInvariant(initialMint);
  });

  it('enforces allowlist, expiry, session pause, global pause, and instant revocation with exact refund', async () => {
    const { evm, vault, initialMint, tokenBalanceOf, assertSolvencyInvariant } = await setupFixture();
    const validUntil = evm.timestamp + 3600n;

    await evm.write(PAYER, vault, vaultArtifact.abi, 'createSessionWithDeposit', [
      AGENT.address,
      u6('20'),
      u6('50'),
      u6('80'),
      validUntil,
      true,
      [VENDOR_A.address],
      'Restricted Vendor Agent',
    ]);

    const memo = keccak256(stringToHex('allowlist-test'));

    // Unauthorized recipient blocked
    await evm.expectRevert(
      () =>
        evm.write(AGENT, vault, vaultArtifact.abi, 'executeAgentPayment', [
          1n,
          VENDOR_B.address,
          u6('10'),
          0n,
          memo,
        ]),
      'RecipientNotAllowed'
    );

    // Add VENDOR_B dynamically -> succeeds
    await evm.write(PAYER, vault, vaultArtifact.abi, 'setSessionAllowlist', [1n, [VENDOR_B.address], true]);
    await evm.write(AGENT, vault, vaultArtifact.abi, 'executeAgentPayment', [
      1n,
      VENDOR_B.address,
      u6('10'),
      0n,
      memo,
    ]);
    expect(await tokenBalanceOf(VENDOR_B.address)).toBe(u6('10'));

    // Session pause blocks execution
    await evm.write(PAYER, vault, vaultArtifact.abi, 'setSessionPaused', [1n, true]);
    await evm.expectRevert(
      () =>
        evm.write(AGENT, vault, vaultArtifact.abi, 'executeAgentPayment', [
          1n,
          VENDOR_A.address,
          u6('5'),
          1n,
          memo,
        ]),
      'SessionIsPaused'
    );
    await evm.write(PAYER, vault, vaultArtifact.abi, 'setSessionPaused', [1n, false]);

    // Global emergency pause blocks agent spending, BUT payer can still revoke & withdraw safely!
    await evm.write(OWNER, vault, vaultArtifact.abi, 'pause');
    await evm.expectRevert(
      () =>
        evm.write(AGENT, vault, vaultArtifact.abi, 'executeAgentPayment', [
          1n,
          VENDOR_A.address,
          u6('5'),
          1n,
          memo,
        ]),
      'ContractPaused'
    );

    // Revoke returns unspent 70 tUSD8 to payer availableBalance even while paused
    const revokeReceipt = await evm.write(PAYER, vault, vaultArtifact.abi, 'revokeSession', [1n]);
    const revLog = revokeReceipt.logs.find((l) => l.eventName === 'SessionRevoked');
    expect(revLog?.args.refundedAmount).toBe(u6('70'));

    // Payer withdraws refunded 70 tUSD8 even while paused
    const payerBalBefore = await tokenBalanceOf(PAYER.address);
    await evm.write(PAYER, vault, vaultArtifact.abi, 'withdraw', [u6('70'), PAYER.address]);
    expect(await tokenBalanceOf(PAYER.address)).toBe(payerBalBefore + u6('70'));

    // Unpause -> revoked session remains permanently inactive
    await evm.write(OWNER, vault, vaultArtifact.abi, 'unpause');
    await evm.expectRevert(
      () =>
        evm.write(AGENT, vault, vaultArtifact.abi, 'executeAgentPayment', [
          1n,
          VENDOR_A.address,
          u6('5'),
          1n,
          memo,
        ]),
      'SessionInactive'
    );

    // Create a second session to verify expiry enforcement
    const shortExpiry = evm.timestamp + 600n;
    await evm.write(PAYER, vault, vaultArtifact.abi, 'createSessionWithDeposit', [
      AGENT.address,
      u6('10'),
      u6('20'),
      u6('20'),
      shortExpiry,
      false,
      [],
      'Short-Lived Session',
    ]);
    evm.advanceTime(601n);
    await evm.expectRevert(
      () =>
        evm.write(AGENT, vault, vaultArtifact.abi, 'executeAgentPayment', [
          2n,
          VENDOR_A.address,
          u6('5'),
          0n,
          memo,
        ]),
      'SessionExpired'
    );

    await assertSolvencyInvariant(initialMint);
  });

  it('executes full Confirmation-of-Payee (CoP) Invoice/Payroll Escrow: claim, wrong-code block, timeout reclaim, and payee reject', async () => {
    const { evm, vault, initialMint, tokenBalanceOf, assertSolvencyInvariant } = await setupFixture();
    const sessionValidUntil = evm.timestamp + 30n * 86_400n;

    await evm.write(PAYER, vault, vaultArtifact.abi, 'createSessionWithDeposit', [
      AGENT.address,
      u6('100'),
      u6('250'),
      u6('500'),
      sessionValidUntil,
      true,
      [VENDOR_A.address, VENDOR_B.address],
      'Payroll & Vendor Escrow Agent',
    ]);

    // 1. Agent stages Invoice #1 for VENDOR_A using EIP-712 signature
    const code1 = 'INV-2026-Q4-ALPHA-9482';
    const hash1 = await evm.read<Hex>(vault, vaultArtifact.abi, 'computeConfirmationHash', [
      VENDOR_A.address,
      code1,
    ]);
    const exp1 = evm.timestamp + 86_400n;
    const deadline1 = evm.timestamp + 3600n;

    const invSig = await signAgentInvoice(AGENT, vault, {
      sessionId: 1n,
      payee: VENDOR_A.address,
      amount: u6('75'),
      expiresAt: exp1,
      confirmationHash: hash1,
      nonce: 0n,
      deadline: deadline1,
    });

    const createInvReceipt = await evm.write(
      RELAYER,
      vault,
      vaultArtifact.abi,
      'createInvoiceByAgentWithSig',
      [1n, VENDOR_A.address, u6('75'), exp1, hash1, 'ipfs://invoice-alpha-001', 0n, deadline1, invSig]
    );
    expect(createInvReceipt.logs.some((l) => l.eventName === 'InvoiceCreated')).toBe(true);

    // Wrong payee cannot claim even if they somehow learn code1
    await evm.expectRevert(
      () => evm.write(ATTACKER, vault, vaultArtifact.abi, 'confirmAndClaimInvoice', [1n, code1]),
      'Unauthorized'
    );

    // Intended payee with wrong CoP code cannot claim
    await evm.expectRevert(
      () =>
        evm.write(VENDOR_A, vault, vaultArtifact.abi, 'confirmAndClaimInvoice', [
          1n,
          'WRONG-CODE',
        ]),
      'InvalidConfirmationCode'
    );

    // Payer cannot rug/reclaim before expiry
    await evm.expectRevert(
      () => evm.write(PAYER, vault, vaultArtifact.abi, 'reclaimExpiredInvoice', [1n]),
      'InvoiceNotYetExpired'
    );

    // Intended payee confirms exact CoP code -> settles immediately!
    const claimReceipt = await evm.write(VENDOR_A, vault, vaultArtifact.abi, 'confirmAndClaimInvoice', [
      1n,
      code1,
    ]);
    expect(claimReceipt.logs.some((l) => l.eventName === 'InvoiceConfirmedAndPaid')).toBe(true);
    expect(await tokenBalanceOf(VENDOR_A.address)).toBe(u6('75'));

    // Replay/double claim fails
    await evm.expectRevert(
      () => evm.write(VENDOR_A, vault, vaultArtifact.abi, 'confirmAndClaimInvoice', [1n, code1]),
      'InvoiceNotPending'
    );

    // 2. Agent stages Invoice #2 for VENDOR_B -> never confirmed -> payer reclaims safely after expiry!
    const code2 = 'PAYROLL-MISTYPED-ADDR-7721';
    const hash2 = await evm.read<Hex>(vault, vaultArtifact.abi, 'computeConfirmationHash', [
      VENDOR_B.address,
      code2,
    ]);
    const exp2 = evm.timestamp + 3600n;
    await evm.write(AGENT, vault, vaultArtifact.abi, 'createInvoiceByAgent', [
      1n,
      VENDOR_B.address,
      u6('50'),
      exp2,
      hash2,
      'ipfs://payroll-002',
      1n,
    ]);

    evm.advanceTime(3601n);
    // Expired claim blocked
    await evm.expectRevert(
      () => evm.write(VENDOR_B, vault, vaultArtifact.abi, 'confirmAndClaimInvoice', [2n, code2]),
      'InvoiceExpired'
    );

    // Payer reclaims full 50 tUSD8 back to availableBalance
    const reclaimReceipt = await evm.write(PAYER, vault, vaultArtifact.abi, 'reclaimExpiredInvoice', [2n]);
    expect(reclaimReceipt.logs.some((l) => l.eventName === 'InvoiceRefunded')).toBe(true);
    expect(await evm.read<bigint>(vault, vaultArtifact.abi, 'availableBalance', [PAYER.address])).toBe(
      u6('50')
    );

    // 3. Payer creates Invoice #3 directly from availableBalance -> VENDOR_B voluntarily rejects -> refunded
    const hash3 = await evm.read<Hex>(vault, vaultArtifact.abi, 'computeConfirmationHash', [
      VENDOR_B.address,
      'INV-REJECT-TEST',
    ]);
    await evm.write(PAYER, vault, vaultArtifact.abi, 'createInvoiceByPayer', [
      VENDOR_B.address,
      u6('30'),
      evm.timestamp + 7200n,
      hash3,
      'ipfs://invoice-003',
    ]);
    await evm.write(VENDOR_B, vault, vaultArtifact.abi, 'rejectInvoice', [3n]);
    expect(await evm.read<bigint>(vault, vaultArtifact.abi, 'availableBalance', [PAYER.address])).toBe(
      u6('50')
    );

    await assertSolvencyInvariant(initialMint);
  });

  it('preserves strict solvency, budget, and daily-limit invariants across a 60-step randomized fuzz sequence', async () => {
    const { evm, vault, initialMint, assertSolvencyInvariant } = await setupFixture();

    // Seeded deterministic PRNG (Mulberry32) so fuzz test is 100% reproducible
    let seed = 0x44005aef >>> 0;
    const nextRand = () => {
      seed = (seed + 0x6d2b79f5) >>> 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const randInt = (min: number, max: number) => min + Math.floor(nextRand() * (max - min + 1));

    // Deposit initial 2,000 tUSD8 to payer treasury
    await evm.write(PAYER, vault, vaultArtifact.abi, 'deposit', [u6('2000')]);

    // Create 3 agent sessions with different limits
    const activeSessions: bigint[] = [];
    for (let i = 0; i < 3; i++) {
      const perTx = BigInt(randInt(10, 40)) * 1_000_000n;
      const daily = perTx * 2n;
      const budget = daily * 3n;
      await evm.write(PAYER, vault, vaultArtifact.abi, 'createSession', [
        AGENT.address,
        perTx,
        daily,
        budget,
        evm.timestamp + 10n * 86_400n,
        i % 2 === 0,
        [VENDOR_A.address, VENDOR_B.address],
        `Fuzz-Session-${i + 1}`,
      ]);
      activeSessions.push(BigInt(i + 1));
    }

    const pendingInvoices: Array<{ id: bigint; payee: TestActor; code: string; expiresAt: bigint }> = [];

    for (let step = 0; step < 60; step++) {
      const action = randInt(0, 6);
      const sessionId = activeSessions[randInt(0, activeSessions.length - 1)];

      if (action === 0) {
        // Advance clock 1..10 hours
        evm.advanceTime(BigInt(randInt(1, 10)) * 3600n);
      } else if (action === 1 || action === 2) {
        // Attempt direct or EIP-712 payment (randomly valid or over-cap)
        const target = randInt(0, 1) === 0 ? VENDOR_A : VENDOR_B;
        const amount = BigInt(randInt(1, 55)) * 1_000_000n;
        const nonce = await evm.read<bigint>(vault, vaultArtifact.abi, 'sessionNonces', [sessionId]);
        const memo = keccak256(stringToHex(`fuzz-step-${step}`));

        try {
          if (action === 1) {
            await evm.write(AGENT, vault, vaultArtifact.abi, 'executeAgentPayment', [
              sessionId,
              target.address,
              amount,
              nonce,
              memo,
            ]);
          } else {
            const deadline = evm.timestamp + 600n;
            const sig = await signAgentPayment(AGENT, vault, {
              sessionId,
              recipient: target.address,
              amount,
              nonce,
              deadline,
              memoHash: memo,
            });
            await evm.write(RELAYER, vault, vaultArtifact.abi, 'executeAgentPaymentWithSig', [
              sessionId,
              target.address,
              amount,
              nonce,
              deadline,
              memo,
              sig,
            ]);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          // Only expected policy-guardrail reverts are permitted
          expect(msg).toMatch(
            /PerTxLimitExceeded|DailyLimitExceeded|BudgetExceeded|SessionInactive|SessionExpired/
          );
        }
      } else if (action === 3) {
        // Stage an agent CoP invoice
        const target = randInt(0, 1) === 0 ? VENDOR_A : VENDOR_B;
        const amount = BigInt(randInt(5, 35)) * 1_000_000n;
        const nonce = await evm.read<bigint>(vault, vaultArtifact.abi, 'sessionNonces', [sessionId]);
        const code = `FUZZ-COP-${step}`;
        const hash = await evm.read<Hex>(vault, vaultArtifact.abi, 'computeConfirmationHash', [
          target.address,
          code,
        ]);
        const expiresAt = evm.timestamp + BigInt(randInt(2, 12)) * 3600n;

        try {
          const res = await evm.write(AGENT, vault, vaultArtifact.abi, 'createInvoiceByAgent', [
            sessionId,
            target.address,
            amount,
            expiresAt,
            hash,
            `ipfs://fuzz-${step}`,
            nonce,
          ]);
          const invLog = res.logs.find((l) => l.eventName === 'InvoiceCreated');
          if (invLog) {
            pendingInvoices.push({
              id: invLog.args.invoiceId as bigint,
              payee: target,
              code,
              expiresAt,
            });
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          expect(msg).toMatch(
            /PerTxLimitExceeded|DailyLimitExceeded|BudgetExceeded|SessionInactive|SessionExpired/
          );
        }
      } else if (action === 4 && pendingInvoices.length > 0) {
        // Settle or reclaim an existing invoice
        const item = pendingInvoices.shift()!;
        if (evm.timestamp <= item.expiresAt) {
          if (randInt(0, 3) === 0) {
            await evm.write(item.payee, vault, vaultArtifact.abi, 'rejectInvoice', [item.id]);
          } else {
            await evm.write(item.payee, vault, vaultArtifact.abi, 'confirmAndClaimInvoice', [
              item.id,
              item.code,
            ]);
          }
        } else {
          await evm.write(PAYER, vault, vaultArtifact.abi, 'reclaimExpiredInvoice', [item.id]);
        }
      } else if (action === 5) {
        // Top up an active session if payer has treasury balance
        const payerAvail = await evm.read<bigint>(vault, vaultArtifact.abi, 'availableBalance', [
          PAYER.address,
        ]);
        if (payerAvail >= u6('20')) {
          try {
            await evm.write(PAYER, vault, vaultArtifact.abi, 'topUpSession', [sessionId, u6('20')]);
          } catch (err) {
            expect(String(err)).toMatch(/SessionInactive/);
          }
        }
      } else if (action === 6 && step > 45) {
        // Late-stage revocation test
        try {
          await evm.write(PAYER, vault, vaultArtifact.abi, 'revokeSession', [sessionId]);
        } catch (err) {
          expect(String(err)).toMatch(/SessionInactive/);
        }
      }

      // Assert exact conservation-of-funds + per-session safety invariants on EVERY step
      await assertSolvencyInvariant(initialMint);
      for (const sid of activeSessions) {
        const s = await evm.read<{
          totalBudget: bigint;
          spentTotal: bigint;
          dailyLimit: bigint;
        }>(vault, vaultArtifact.abi, 'getSession', [sid]);
        expect(s.spentTotal <= s.totalBudget).toBe(true);
        const rolling = await evm.read<bigint>(vault, vaultArtifact.abi, 'getRolling24hSpent', [sid]);
        expect(rolling <= s.dailyLimit).toBe(true);
      }
    }
  });
});
