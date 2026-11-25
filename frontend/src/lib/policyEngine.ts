import {
  encodeAbiParameters,
  formatUnits,
  hashTypedData,
  keccak256,
  parseAbiParameters,
  parseUnits,
  stringToHex,
  type Address,
  type Hex,
} from 'viem';
import {
  AEVUM_CHAIN_ID,
  AGENT_PAYMENT_TYPES,
  EIP712_DOMAIN_NAME,
  EIP712_DOMAIN_VERSION,
  LIVE_TUSD8_DECIMALS,
} from '@shared/aevum';

export const SANDBOX_ACTORS = {
  payer: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as Address,
  agent: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC' as Address,
  cloudVendor: '0x90F79bf6EB2c4f870365E785982E1f101E93b906' as Address,
  contractorPayee: '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65' as Address,
  rogueAddress: '0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc' as Address,
  sandboxVault: '0x0000000000000000000000000000000000044005' as Address,
} as const;

export interface SandboxSession {
  id: number;
  payer: Address;
  agent: Address;
  perTxLimit: bigint;
  dailyLimit: bigint;
  totalBudget: bigint;
  spentTotal: bigint;
  validUntil: number;
  enforceAllowlist: boolean;
  allowlist: Address[];
  active: boolean;
  paused: boolean;
  nonce: number;
  label: string;
  hourlySpend: Record<number, bigint>;
}

export type InvoiceStatus = 'Pending' | 'Claimed' | 'Refunded';

export interface SandboxInvoice {
  id: number;
  sessionId: number;
  payer: Address;
  payee: Address;
  amount: bigint;
  createdAt: number;
  expiresAt: number;
  settledAt: number | null;
  status: InvoiceStatus;
  confirmationHash: Hex;
  invoiceURI: string;
  hintCode?: string;
}

export interface AuditEntry {
  id: number;
  timestamp: number;
  kind: 'event' | 'blocked';
  title: string;
  detail: string;
  errorCode?: string;
  digest?: Hex;
}

export interface SandboxState {
  nowSec: number;
  globalPaused: boolean;
  payerWalletBalance: bigint;
  payerAvailableBalance: bigint;
  recipientBalances: Record<string, bigint>;
  sessions: SandboxSession[];
  invoices: SandboxInvoice[];
  auditLog: AuditEntry[];
  nextSessionId: number;
  nextInvoiceId: number;
  nextAuditId: number;
}

export function fmtTusd8(value: bigint): string {
  const num = Number(formatUnits(value, LIVE_TUSD8_DECIMALS));
  return num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 });
}

export function parseTusd8(input: string): bigint {
  const cleaned = input.trim();
  if (!cleaned || Number.isNaN(Number(cleaned)) || Number(cleaned) <= 0) {
    throw new Error('ZeroAmount() — enter a positive tUSD8 amount');
  }
  return parseUnits(cleaned, LIVE_TUSD8_DECIMALS);
}

export function computeCoPHash(payee: Address, confirmationCode: string): Hex {
  return keccak256(
    encodeAbiParameters(parseAbiParameters('address, string'), [payee, confirmationCode])
  );
}

export function computeAgentPaymentDigest(
  verifyingContract: Address,
  sessionId: number,
  recipient: Address,
  amount: bigint,
  nonce: number,
  deadline: number,
  memo: string
): Hex {
  return hashTypedData({
    domain: {
      name: EIP712_DOMAIN_NAME,
      version: EIP712_DOMAIN_VERSION,
      chainId: AEVUM_CHAIN_ID,
      verifyingContract,
    },
    types: AGENT_PAYMENT_TYPES,
    primaryType: 'AgentPayment',
    message: {
      sessionId: BigInt(sessionId),
      recipient,
      amount,
      nonce: BigInt(nonce),
      deadline: BigInt(deadline),
      memoHash: keccak256(stringToHex(memo)),
    },
  });
}

export function getRolling24hSpent(session: SandboxSession, nowSec: number): bigint {
  const currentHour = Math.floor(nowSec / 3600);
  const startHour = Math.max(0, currentHour - 23);
  let total = 0n;
  for (let h = startHour; h <= currentHour; h++) {
    total += session.hourlySpend[h] ?? 0n;
  }
  return total;
}

export function getSolvencySummary(state: SandboxState) {
  const available = state.payerAvailableBalance;
  const sessionUnspent = state.sessions
    .filter((s) => s.active)
    .reduce((acc, s) => acc + (s.totalBudget - s.spentTotal), 0n);
  const escrowedInvoices = state.invoices
    .filter((inv) => inv.status === 'Pending')
    .reduce((acc, inv) => acc + inv.amount, 0n);
  return {
    available,
    sessionUnspent,
    escrowedInvoices,
    vaultTotal: available + sessionUnspent + escrowedInvoices,
  };
}

export function createInitialSandboxState(): SandboxState {
  const nowSec = Math.floor(Date.now() / 1000);
  const initialSession: SandboxSession = {
    id: 1,
    payer: SANDBOX_ACTORS.payer,
    agent: SANDBOX_ACTORS.agent,
    perTxLimit: parseUnits('25', 6),
    dailyLimit: parseUnits('50', 6),
    totalBudget: parseUnits('150', 6),
    spentTotal: 0n,
    validUntil: nowSec + 7 * 86_400,
    enforceAllowlist: true,
    allowlist: [SANDBOX_ACTORS.cloudVendor, SANDBOX_ACTORS.contractorPayee],
    active: true,
    paused: false,
    nonce: 0,
    label: 'Ops AI Procurement Agent',
    hourlySpend: {},
  };

  const sampleCode = 'INV-2026-Q4-8841';
  const initialInvoice: SandboxInvoice = {
    id: 1,
    sessionId: 0,
    payer: SANDBOX_ACTORS.payer,
    payee: SANDBOX_ACTORS.contractorPayee,
    amount: parseUnits('40', 6),
    createdAt: nowSec,
    expiresAt: nowSec + 24 * 3600,
    settledAt: null,
    status: 'Pending',
    confirmationHash: computeCoPHash(SANDBOX_ACTORS.contractorPayee, sampleCode),
    invoiceURI: 'ipfs://aevum-payroll-milestone-q4-01',
    hintCode: sampleCode,
  };

  return {
    nowSec,
    globalPaused: false,
    payerWalletBalance: parseUnits('810', 6),
    payerAvailableBalance: parseUnits('200', 6),
    recipientBalances: {
      [SANDBOX_ACTORS.cloudVendor.toLowerCase()]: 0n,
      [SANDBOX_ACTORS.contractorPayee.toLowerCase()]: 0n,
      [SANDBOX_ACTORS.rogueAddress.toLowerCase()]: 0n,
    },
    sessions: [initialSession],
    invoices: [initialInvoice],
    auditLog: [
      {
        id: 2,
        timestamp: nowSec,
        kind: 'event',
        title: 'InvoiceCreated (#1)',
        detail:
          '40.00 tUSD8 escrowed for Contractor Payee with Confirmation-of-Payee hash bound to payee address.',
      },
      {
        id: 1,
        timestamp: nowSec,
        kind: 'event',
        title: 'SessionCreated (#1)',
        detail:
          'Funded "Ops AI Procurement Agent" with 150.00 tUSD8 budget (Per-Tx 25.00 / Rolling-24h 50.00 / Allowlist ON).',
      },
    ],
    nextSessionId: 2,
    nextInvoiceId: 2,
    nextAuditId: 3,
  };
}

function appendAudit(
  state: SandboxState,
  entry: Omit<AuditEntry, 'id' | 'timestamp'>
): SandboxState {
  return {
    ...state,
    nextAuditId: state.nextAuditId + 1,
    auditLog: [
      {
        ...entry,
        id: state.nextAuditId,
        timestamp: state.nowSec,
      },
      ...state.auditLog,
    ].slice(0, 40),
  };
}

export function sandboxCreateSession(
  state: SandboxState,
  params: {
    label: string;
    agent: Address;
    perTxLimit: bigint;
    dailyLimit: bigint;
    totalBudget: bigint;
    durationDays: number;
    enforceAllowlist: boolean;
    allowlist: Address[];
  }
): { state: SandboxState; ok: boolean; message: string } {
  if (state.globalPaused) {
    const msg = 'ContractPaused()';
    return {
      ok: false,
      message: msg,
      state: appendAudit(state, { kind: 'blocked', title: 'createSessionWithDeposit', detail: msg, errorCode: 'ContractPaused' }),
    };
  }
  if (
    params.perTxLimit <= 0n ||
    params.dailyLimit <= 0n ||
    params.totalBudget <= 0n ||
    params.perTxLimit > params.dailyLimit ||
    params.perTxLimit > params.totalBudget
  ) {
    const msg = 'InvalidPolicyLimits() — require 0 < perTx <= daily and perTx <= totalBudget';
    return {
      ok: false,
      message: msg,
      state: appendAudit(state, { kind: 'blocked', title: 'createSessionWithDeposit', detail: msg, errorCode: 'InvalidPolicyLimits' }),
    };
  }
  if (state.payerWalletBalance < params.totalBudget) {
    const msg = 'InsufficientTreasuryBalance() — not enough wallet tUSD8';
    return {
      ok: false,
      message: msg,
      state: appendAudit(state, { kind: 'blocked', title: 'createSessionWithDeposit', detail: msg, errorCode: 'InsufficientTreasuryBalance' }),
    };
  }

  const session: SandboxSession = {
    id: state.nextSessionId,
    payer: SANDBOX_ACTORS.payer,
    agent: params.agent,
    perTxLimit: params.perTxLimit,
    dailyLimit: params.dailyLimit,
    totalBudget: params.totalBudget,
    spentTotal: 0n,
    validUntil: state.nowSec + params.durationDays * 86_400,
    enforceAllowlist: params.enforceAllowlist,
    allowlist: params.allowlist,
    active: true,
    paused: false,
    nonce: 0,
    label: params.label.trim() || `AI Agent Session #${state.nextSessionId}`,
    hourlySpend: {},
  };

  const nextState = appendAudit(
    {
      ...state,
      payerWalletBalance: state.payerWalletBalance - params.totalBudget,
      sessions: [session, ...state.sessions],
      nextSessionId: state.nextSessionId + 1,
    },
    {
      kind: 'event',
      title: `SessionCreated (#${session.id})`,
      detail: `Locked ${fmtTusd8(session.totalBudget)} tUSD8 for "${session.label}" (per-tx ${fmtTusd8(session.perTxLimit)}, 24h ${fmtTusd8(session.dailyLimit)}).`,
    }
  );
  return { ok: true, message: `Created Session #${session.id}`, state: nextState };
}

function checkSessionPolicy(
  state: SandboxState,
  session: SandboxSession,
  recipient: Address,
  amount: bigint
): { errorCode: string; detail: string } | null {
  if (state.globalPaused) {
    return { errorCode: 'ContractPaused', detail: 'Global emergency pause is active.' };
  }
  if (!session.active) {
    return { errorCode: 'SessionInactive', detail: `Session #${session.id} was revoked.` };
  }
  if (session.paused) {
    return { errorCode: 'SessionIsPaused', detail: `Session #${session.id} is currently paused by payer.` };
  }
  if (state.nowSec > session.validUntil) {
    return { errorCode: 'SessionExpired', detail: `Session #${session.id} expired past validUntil.` };
  }
  if (
    session.enforceAllowlist &&
    !session.allowlist.some((a) => a.toLowerCase() === recipient.toLowerCase())
  ) {
    return {
      errorCode: 'RecipientNotAllowed',
      detail: `Recipient ${recipient.slice(0, 10)}... is NOT on Session #${session.id} allowlist!`,
    };
  }
  if (amount > session.perTxLimit) {
    return {
      errorCode: 'PerTxLimitExceeded',
      detail: `Requested ${fmtTusd8(amount)} tUSD8 exceeds per-tx limit of ${fmtTusd8(session.perTxLimit)} tUSD8.`,
    };
  }
  const remainingBudget = session.totalBudget - session.spentTotal;
  if (amount > remainingBudget) {
    return {
      errorCode: 'BudgetExceeded',
      detail: `Requested ${fmtTusd8(amount)} tUSD8 exceeds remaining session budget (${fmtTusd8(remainingBudget)} tUSD8).`,
    };
  }
  const rolling = getRolling24hSpent(session, state.nowSec);
  if (rolling + amount > session.dailyLimit) {
    return {
      errorCode: 'DailyLimitExceeded',
      detail: `Projected rolling 24h spend (${fmtTusd8(rolling + amount)} tUSD8) exceeds daily cap (${fmtTusd8(session.dailyLimit)} tUSD8).`,
    };
  }
  return null;
}

export function sandboxExecuteAgentPayment(
  state: SandboxState,
  params: {
    sessionId: number;
    recipient: Address;
    amount: bigint;
    memo: string;
    viaSignature: boolean;
  }
): { state: SandboxState; ok: boolean; message: string } {
  const session = state.sessions.find((s) => s.id === params.sessionId);
  if (!session) {
    return { ok: false, message: 'SessionNotFound()', state };
  }

  const digest = computeAgentPaymentDigest(
    SANDBOX_ACTORS.sandboxVault,
    session.id,
    params.recipient,
    params.amount,
    session.nonce,
    state.nowSec + 3600,
    params.memo
  );

  const violation = checkSessionPolicy(state, session, params.recipient, params.amount);
  if (violation) {
    return {
      ok: false,
      message: `${violation.errorCode}: ${violation.detail}`,
      state: appendAudit(state, {
        kind: 'blocked',
        title: `Blocked Agent Payment (Session #${session.id})`,
        detail: violation.detail,
        errorCode: violation.errorCode,
        digest,
      }),
    };
  }

  const currentHour = Math.floor(state.nowSec / 3600);
  const updatedSessions = state.sessions.map((s) =>
    s.id === session.id
      ? {
          ...s,
          spentTotal: s.spentTotal + params.amount,
          nonce: s.nonce + 1,
          hourlySpend: {
            ...s.hourlySpend,
            [currentHour]: (s.hourlySpend[currentHour] ?? 0n) + params.amount,
          },
        }
      : s
  );

  const rKey = params.recipient.toLowerCase();
  const nextState = appendAudit(
    {
      ...state,
      sessions: updatedSessions,
      recipientBalances: {
        ...state.recipientBalances,
        [rKey]: (state.recipientBalances[rKey] ?? 0n) + params.amount,
      },
    },
    {
      kind: 'event',
      title: `AgentPaymentExecuted (Session #${session.id}, Nonce ${session.nonce})`,
      detail: `Paid ${fmtTusd8(params.amount)} tUSD8 to ${params.recipient.slice(0, 10)}... (${params.viaSignature ? 'EIP-712 Relayed' : 'Direct Agent Tx'}). Memo: "${params.memo}".`,
      digest,
    }
  );

  return { ok: true, message: `Settled ${fmtTusd8(params.amount)} tUSD8`, state: nextState };
}

export function sandboxStageInvoice(
  state: SandboxState,
  params: {
    sessionId: number; // 0 = direct payer treasury, >0 = AI agent session
    payee: Address;
    amount: bigint;
    confirmationCode: string;
    expiryHours: number;
    invoiceURI: string;
  }
): { state: SandboxState; ok: boolean; message: string } {
  const confirmationHash = computeCoPHash(params.payee, params.confirmationCode);
  let nextSessions = state.sessions;
  let nextAvailable = state.payerAvailableBalance;

  if (params.sessionId > 0) {
    const session = state.sessions.find((s) => s.id === params.sessionId);
    if (!session) return { ok: false, message: 'SessionNotFound()', state };
    const violation = checkSessionPolicy(state, session, params.payee, params.amount);
    if (violation) {
      return {
        ok: false,
        message: `${violation.errorCode}: ${violation.detail}`,
        state: appendAudit(state, {
          kind: 'blocked',
          title: `Blocked Agent Invoice (Session #${session.id})`,
          detail: violation.detail,
          errorCode: violation.errorCode,
        }),
      };
    }
    const currentHour = Math.floor(state.nowSec / 3600);
    nextSessions = state.sessions.map((s) =>
      s.id === session.id
        ? {
            ...s,
            spentTotal: s.spentTotal + params.amount,
            nonce: s.nonce + 1,
            hourlySpend: {
              ...s.hourlySpend,
              [currentHour]: (s.hourlySpend[currentHour] ?? 0n) + params.amount,
            },
          }
        : s
    );
  } else {
    if (state.globalPaused) {
      return {
        ok: false,
        message: 'ContractPaused()',
        state: appendAudit(state, { kind: 'blocked', title: 'createInvoiceByPayer', detail: 'Global pause active.', errorCode: 'ContractPaused' }),
      };
    }
    if (state.payerAvailableBalance < params.amount) {
      return {
        ok: false,
        message: 'InsufficientTreasuryBalance()',
        state: appendAudit(state, {
          kind: 'blocked',
          title: 'createInvoiceByPayer',
          detail: `Available treasury ${fmtTusd8(state.payerAvailableBalance)} tUSD8 < ${fmtTusd8(params.amount)} tUSD8.`,
          errorCode: 'InsufficientTreasuryBalance',
        }),
      };
    }
    nextAvailable -= params.amount;
  }

  const invoice: SandboxInvoice = {
    id: state.nextInvoiceId,
    sessionId: params.sessionId,
    payer: SANDBOX_ACTORS.payer,
    payee: params.payee,
    amount: params.amount,
    createdAt: state.nowSec,
    expiresAt: state.nowSec + params.expiryHours * 3600,
    settledAt: null,
    status: 'Pending',
    confirmationHash,
    invoiceURI: params.invoiceURI.trim() || `ipfs://aevum-invoice-${state.nextInvoiceId}`,
    hintCode: params.confirmationCode,
  };

  const nextState = appendAudit(
    {
      ...state,
      payerAvailableBalance: nextAvailable,
      sessions: nextSessions,
      invoices: [invoice, ...state.invoices],
      nextInvoiceId: state.nextInvoiceId + 1,
    },
    {
      kind: 'event',
      title: `InvoiceCreated (#${invoice.id})`,
      detail: `Escrowed ${fmtTusd8(invoice.amount)} tUSD8 (${params.sessionId > 0 ? `via Agent Session #${params.sessionId}` : 'from Payer Treasury'}) for ${params.payee.slice(0, 10)}... with CoP hash ${confirmationHash.slice(0, 14)}...`,
    }
  );
  return { ok: true, message: `Escrowed Invoice #${invoice.id}`, state: nextState };
}

export function sandboxClaimInvoice(
  state: SandboxState,
  invoiceId: number,
  confirmationCode: string,
  caller: Address
): { state: SandboxState; ok: boolean; message: string } {
  const inv = state.invoices.find((i) => i.id === invoiceId);
  if (!inv) return { ok: false, message: 'InvoiceNotFound()', state };
  if (state.globalPaused) {
    return {
      ok: false,
      message: 'ContractPaused()',
      state: appendAudit(state, { kind: 'blocked', title: `confirmAndClaimInvoice (#${invoiceId})`, detail: 'Contract paused.', errorCode: 'ContractPaused' }),
    };
  }
  if (inv.status !== 'Pending') {
    return { ok: false, message: 'InvoiceNotPending()', state };
  }
  if (caller.toLowerCase() !== inv.payee.toLowerCase()) {
    const detail = `Caller ${caller.slice(0, 10)}... is not designated payee ${inv.payee.slice(0, 10)}...`;
    return {
      ok: false,
      message: `Unauthorized(): ${detail}`,
      state: appendAudit(state, { kind: 'blocked', title: `Blocked CoP Claim (#${invoiceId})`, detail, errorCode: 'Unauthorized' }),
    };
  }
  if (state.nowSec > inv.expiresAt) {
    const detail = `Invoice #${invoiceId} expired — payee can no longer claim; payer can reclaim.`;
    return {
      ok: false,
      message: `InvoiceExpired(): ${detail}`,
      state: appendAudit(state, { kind: 'blocked', title: `Blocked Expired Claim (#${invoiceId})`, detail, errorCode: 'InvoiceExpired' }),
    };
  }
  const computed = computeCoPHash(caller, confirmationCode);
  if (computed !== inv.confirmationHash) {
    const detail = `Confirmation-of-Payee hash mismatch for code "${confirmationCode}" — funds remain safely escrowed!`;
    return {
      ok: false,
      message: `InvalidConfirmationCode(): ${detail}`,
      state: appendAudit(state, { kind: 'blocked', title: `Blocked CoP Claim (#${invoiceId})`, detail, errorCode: 'InvalidConfirmationCode' }),
    };
  }

  const pKey = inv.payee.toLowerCase();
  const nextState = appendAudit(
    {
      ...state,
      invoices: state.invoices.map((i) =>
        i.id === invoiceId ? { ...i, status: 'Claimed', settledAt: state.nowSec } : i
      ),
      recipientBalances: {
        ...state.recipientBalances,
        [pKey]: (state.recipientBalances[pKey] ?? 0n) + inv.amount,
      },
    },
    {
      kind: 'event',
      title: `InvoiceConfirmedAndPaid (#${invoiceId})`,
      detail: `Payee ${inv.payee.slice(0, 10)}... verified CoP code and settled ${fmtTusd8(inv.amount)} tUSD8.`,
    }
  );
  return { ok: true, message: `Settled ${fmtTusd8(inv.amount)} tUSD8 to payee`, state: nextState };
}

export function sandboxReclaimInvoice(
  state: SandboxState,
  invoiceId: number
): { state: SandboxState; ok: boolean; message: string } {
  const inv = state.invoices.find((i) => i.id === invoiceId);
  if (!inv || inv.status !== 'Pending') return { ok: false, message: 'InvoiceNotPending()', state };
  if (state.nowSec <= inv.expiresAt) {
    const remainingHrs = Math.ceil((inv.expiresAt - state.nowSec) / 3600);
    const detail = `Cannot reclaim yet — escrow locked for payee for ~${remainingHrs}h more (advance sandbox clock +25h to test timeout recovery).`;
    return {
      ok: false,
      message: `InvoiceNotYetExpired(): ${detail}`,
      state: appendAudit(state, { kind: 'blocked', title: `Blocked Early Reclaim (#${invoiceId})`, detail, errorCode: 'InvoiceNotYetExpired' }),
    };
  }

  const nextState = appendAudit(
    {
      ...state,
      payerAvailableBalance: state.payerAvailableBalance + inv.amount,
      invoices: state.invoices.map((i) =>
        i.id === invoiceId ? { ...i, status: 'Refunded', settledAt: state.nowSec } : i
      ),
    },
    {
      kind: 'event',
      title: `InvoiceRefunded (#${invoiceId})`,
      detail: `Expired unclaimed invoice refunded ${fmtTusd8(inv.amount)} tUSD8 back to Payer Treasury.`,
    }
  );
  return { ok: true, message: `Reclaimed ${fmtTusd8(inv.amount)} tUSD8`, state: nextState };
}

export function sandboxTogglePauseSession(state: SandboxState, sessionId: number): SandboxState {
  const target = state.sessions.find((s) => s.id === sessionId);
  if (!target || !target.active) return state;
  const nextPaused = !target.paused;
  return appendAudit(
    {
      ...state,
      sessions: state.sessions.map((s) => (s.id === sessionId ? { ...s, paused: nextPaused } : s)),
    },
    {
      kind: 'event',
      title: `SessionPauseUpdated (#${sessionId})`,
      detail: `Session #${sessionId} ${nextPaused ? 'PAUSED' : 'RESUMED'} by payer.`,
    }
  );
}

export function sandboxRevokeSession(state: SandboxState, sessionId: number): SandboxState {
  const target = state.sessions.find((s) => s.id === sessionId);
  if (!target || !target.active) return state;
  const refunded = target.totalBudget - target.spentTotal;
  return appendAudit(
    {
      ...state,
      payerAvailableBalance: state.payerAvailableBalance + refunded,
      sessions: state.sessions.map((s) =>
        s.id === sessionId ? { ...s, active: false, totalBudget: s.spentTotal } : s
      ),
    },
    {
      kind: 'event',
      title: `SessionRevoked (#${sessionId})`,
      detail: `Kill switch triggered — revoked agent key and returned ${fmtTusd8(refunded)} tUSD8 unspent budget to Payer Treasury.`,
    }
  );
}
