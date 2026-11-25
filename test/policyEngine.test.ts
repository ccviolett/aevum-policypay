import { describe, expect, it } from 'vitest';
import {
  SANDBOX_ACTORS,
  computeCoPHash,
  createInitialSandboxState,
  getRolling24hSpent,
  getSolvencySummary,
  parseTusd8,
  sandboxClaimInvoice,
  sandboxExecuteAgentPayment,
  sandboxReclaimInvoice,
  sandboxRevokeSession,
  sandboxStageInvoice,
} from '../frontend/src/lib/policyEngine.js';
import { loadArtifact, LocalAevumEvm, makeActor } from './evmHarness.js';

describe('Frontend Sandbox PolicyEngine Parity with Solidity Contract', () => {
  it('computes identical Confirmation-of-Payee hash as AevumPolicyPayVault.computeConfirmationHash()', async () => {
    const owner = makeActor(
      'owner',
      '0x2000000000000000000000000000000000000000000000000000000000000001'
    );
    const evm = await LocalAevumEvm.create([owner]);
    const tokenArt = loadArtifact('MockTUSD8');
    const vaultArt = loadArtifact('AevumPolicyPayVault');
    const { address: token } = await evm.deploy(owner, tokenArt);
    const { address: vault } = await evm.deploy(owner, vaultArt, [token]);

    const code = 'INV-2026-Q4-8841';
    const onChainHash = await evm.read<string>(vault, vaultArt.abi, 'computeConfirmationHash', [
      SANDBOX_ACTORS.contractorPayee,
      code,
    ]);
    const frontendHash = computeCoPHash(SANDBOX_ACTORS.contractorPayee, code);

    expect(frontendHash.toLowerCase()).toBe(onChainHash.toLowerCase());
  });

  it('enforces per-tx cap, allowlist, rolling 24h reset, CoP claim/reclaim, and solvency conservation', () => {
    let state = createInitialSandboxState();
    const initialTotal =
      state.payerWalletBalance + getSolvencySummary(state).vaultTotal;

    // Valid payment within policy
    let res = sandboxExecuteAgentPayment(state, {
      sessionId: 1,
      recipient: SANDBOX_ACTORS.cloudVendor,
      amount: parseTusd8('25'),
      memo: 'ok-1',
      viaSignature: true,
    });
    expect(res.ok).toBe(true);
    state = res.state;

    // Overspend blocked
    res = sandboxExecuteAgentPayment(state, {
      sessionId: 1,
      recipient: SANDBOX_ACTORS.cloudVendor,
      amount: parseTusd8('26'),
      memo: 'overspend',
      viaSignature: true,
    });
    expect(res.ok).toBe(false);
    expect(res.message).toContain('PerTxLimitExceeded');

    // Unlisted address blocked
    res = sandboxExecuteAgentPayment(state, {
      sessionId: 1,
      recipient: SANDBOX_ACTORS.rogueAddress,
      amount: parseTusd8('5'),
      memo: 'rogue',
      viaSignature: true,
    });
    expect(res.ok).toBe(false);
    expect(res.message).toContain('RecipientNotAllowed');

    // Second 25 tUSD8 hits rolling 24h cap (50), third reverts DailyLimitExceeded
    state = sandboxExecuteAgentPayment(state, {
      sessionId: 1,
      recipient: SANDBOX_ACTORS.cloudVendor,
      amount: parseTusd8('25'),
      memo: 'ok-2',
      viaSignature: false,
    }).state;
    expect(getRolling24hSpent(state.sessions[0], state.nowSec)).toBe(parseTusd8('50'));

    res = sandboxExecuteAgentPayment(state, {
      sessionId: 1,
      recipient: SANDBOX_ACTORS.cloudVendor,
      amount: parseTusd8('1'),
      memo: 'over-daily',
      viaSignature: false,
    });
    expect(res.ok).toBe(false);
    expect(res.message).toContain('DailyLimitExceeded');

    // CoP wrong code blocked, right code succeeds
    res = sandboxClaimInvoice(state, 1, 'WRONG', SANDBOX_ACTORS.contractorPayee);
    expect(res.ok).toBe(false);
    expect(res.message).toContain('InvalidConfirmationCode');

    res = sandboxClaimInvoice(state, 1, 'INV-2026-Q4-8841', SANDBOX_ACTORS.contractorPayee);
    expect(res.ok).toBe(true);
    state = res.state;

    // Stage invoice #2, advance +25h, verify reclaim succeeds
    state = sandboxStageInvoice(state, {
      sessionId: 0,
      payee: SANDBOX_ACTORS.contractorPayee,
      amount: parseTusd8('30'),
      confirmationCode: 'EXP-TEST',
      expiryHours: 24,
      invoiceURI: 'ipfs://exp-test',
    }).state;

    expect(sandboxReclaimInvoice(state, 2).ok).toBe(false);
    state = { ...state, nowSec: state.nowSec + 25 * 3600 };
    res = sandboxReclaimInvoice(state, 2);
    expect(res.ok).toBe(true);
    state = res.state;

    // Revoke session #1 and verify conservation of total funds across wallet + vault + recipients
    state = sandboxRevokeSession(state, 1);
    const recipientsSum = Object.values(state.recipientBalances).reduce((a, b) => a + b, 0n);
    const finalTotal =
      state.payerWalletBalance + getSolvencySummary(state).vaultTotal + recipientsSum;
    expect(finalTotal).toBe(initialTotal);
  });
});
