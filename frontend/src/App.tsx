import { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  Bot,
  CheckCircle2,
  Clock,
  ExternalLink,
  FileCheck2,
  Lock,
  Play,
  RefreshCw,
  Shield,
  ShieldAlert,
  Wallet,
  XCircle,
} from 'lucide-react';
import { isAddress, type Address } from 'viem';
import {
  AEVUM_CHAIN_ID,
  AEVUM_EXPLORER_URL,
  AEVUM_FAUCET_URL,
  AEVUM_RPC_URL,
  LIVE_TUSD8_ADDRESS,
  explorerAddressUrl,
  explorerTxUrl,
} from '@shared/aevum';
import {
  connectAevumWallet,
  fetchLiveAevumTelemetry,
  liveApproveAndCreateSession,
  liveConfirmAndClaimInvoice,
  readLiveVaultSnapshot,
  type LiveAevumTelemetry,
  type LiveVaultSnapshot,
} from './lib/aevumClient';
import {
  SANDBOX_ACTORS,
  computeCoPHash,
  createInitialSandboxState,
  fmtTusd8,
  getRolling24hSpent,
  getSolvencySummary,
  parseTusd8,
  sandboxClaimInvoice,
  sandboxCreateSession,
  sandboxExecuteAgentPayment,
  sandboxReclaimInvoice,
  sandboxRevokeSession,
  sandboxStageInvoice,
  sandboxTogglePauseSession,
  type SandboxState,
} from './lib/policyEngine';

type Mode = 'sandbox' | 'live';
type Tab = 'agent' | 'cop' | 'audit';

const ENV_VAULT_ADDR = (import.meta.env.VITE_VAULT_ADDRESS as string | undefined) ?? '';

export default function App() {
  const [mode, setMode] = useState<Mode>('sandbox');
  const [tab, setTab] = useState<Tab>('agent');
  const [sandbox, setSandbox] = useState<SandboxState>(() => createInitialSandboxState());
  const [statusBanner, setStatusBanner] = useState<{ ok: boolean; text: string } | null>(null);

  // Live Aevum telemetry (always fetched from live rpc-test.qday.info!)
  const [telemetry, setTelemetry] = useState<LiveAevumTelemetry | null>(null);
  const [walletInfo, setWalletInfo] = useState<{
    account: Address;
    tQdayBalance: string;
    tUsd8Balance: string;
  } | null>(null);
  const [vaultAddressInput, setVaultAddressInput] = useState<string>(ENV_VAULT_ADDR);
  const [liveSnapshot, setLiveSnapshot] = useState<LiveVaultSnapshot | null>(null);
  const [liveTxLinks, setLiveTxLinks] = useState<Array<{ label: string; hash: string }>>([]);
  const [busy, setBusy] = useState(false);

  // Form states — Create Session
  const [sessLabel, setSessLabel] = useState('Autonomous Cloud Billing Agent');
  const [sessAgent, setSessAgent] = useState<string>(SANDBOX_ACTORS.agent);
  const [sessPerTx, setSessPerTx] = useState('25');
  const [sessDaily, setSessDaily] = useState('50');
  const [sessBudget, setSessBudget] = useState('100');
  const [sessDays, setSessDays] = useState('7');
  const [sessEnforceAllow, setSessEnforceAllow] = useState(true);

  // Form states — Execute Agent Payment
  const [paySessionId, setPaySessionId] = useState<number>(1);
  const [payRecipient, setPayRecipient] = useState<string>(SANDBOX_ACTORS.cloudVendor);
  const [payAmount, setPayAmount] = useState('15');
  const [payMemo, setPayMemo] = useState('api-inference-settlement-batch-14');
  const [payViaSig, setPayViaSig] = useState(true);

  // Form states — CoP Invoice Staging & Claiming
  const [invSourceSession, setInvSourceSession] = useState<number>(1);
  const [invPayee, setInvPayee] = useState<string>(SANDBOX_ACTORS.contractorPayee);
  const [invAmount, setInvAmount] = useState('20');
  const [invCode, setInvCode] = useState('PAYROLL-HK-2026-Q4');
  const [invExpiryHrs, setInvExpiryHrs] = useState('24');
  const [invUri, setInvUri] = useState('ipfs://aevum-contractor-invoice-002');
  const [claimCodes, setClaimCodes] = useState<Record<number, string>>({
    1: 'INV-2026-Q4-8841',
  });
  const [liveClaimId, setLiveClaimId] = useState('1');
  const [liveClaimCode, setLiveClaimCode] = useState('AEVUM-COP-2026-VERIFIED');

  const refreshTelemetry = async () => {
    const data = await fetchLiveAevumTelemetry();
    setTelemetry(data);
  };

  useEffect(() => {
    void refreshTelemetry();
  }, []);

  const solvency = useMemo(() => getSolvencySummary(sandbox), [sandbox]);
  const previewCoPHash = useMemo(() => {
    if (!isAddress(invPayee) || !invCode.trim()) return '0x… (enter valid payee address & CoP code)';
    return computeCoPHash(invPayee as Address, invCode.trim());
  }, [invPayee, invCode]);

  const handleConnectWallet = async () => {
    setBusy(true);
    try {
      const info = await connectAevumWallet();
      setWalletInfo(info);
      setMode('live');
      setStatusBanner({
        ok: true,
        text: `Connected ${info.account.slice(0, 8)}…${info.account.slice(-6)} on QDay Aevum (Chain ID ${AEVUM_CHAIN_ID})`,
      });
      if (isAddress(vaultAddressInput)) {
        const snap = await readLiveVaultSnapshot(vaultAddressInput as Address, info.account);
        setLiveSnapshot(snap);
      }
    } catch (err) {
      setStatusBanner({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const handleRefreshLiveVault = async () => {
    if (!isAddress(vaultAddressInput)) {
      setStatusBanner({ ok: false, text: 'Enter a valid deployed AevumPolicyPayVault contract address.' });
      return;
    }
    setBusy(true);
    try {
      const snap = await readLiveVaultSnapshot(vaultAddressInput as Address, walletInfo?.account);
      setLiveSnapshot(snap);
      setStatusBanner({ ok: true, text: `Synced live state from ${vaultAddressInput.slice(0, 10)}… on Aevum Testnet.` });
    } catch (err) {
      setStatusBanner({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  // Guided 30-second Judge Walkthrough (Runs valid tx -> rogue overspend block -> unapproved address block -> CoP claim)
  const handleGuidedDemo = () => {
    let s = createInitialSandboxState();
    // 1. Legit EIP-712 agent payment of 20 tUSD8
    s = sandboxExecuteAgentPayment(s, {
      sessionId: 1,
      recipient: SANDBOX_ACTORS.cloudVendor,
      amount: parseTusd8('20'),
      memo: 'gpu-cluster-usage-ok',
      viaSignature: true,
    }).state;
    // 2. Rogue hallucinated overspend of 60 tUSD8 -> BLOCKED by PerTxLimitExceeded
    s = sandboxExecuteAgentPayment(s, {
      sessionId: 1,
      recipient: SANDBOX_ACTORS.cloudVendor,
      amount: parseTusd8('60'),
      memo: 'rogue-hallucinated-drain',
      viaSignature: true,
    }).state;
    // 3. Prompt-injected drain to attacker address -> BLOCKED by RecipientNotAllowed
    s = sandboxExecuteAgentPayment(s, {
      sessionId: 1,
      recipient: SANDBOX_ACTORS.rogueAddress,
      amount: parseTusd8('10'),
      memo: 'prompt-injection-exfil',
      viaSignature: true,
    }).state;
    // 4. Wrong CoP code attempt on Invoice #1 -> BLOCKED by InvalidConfirmationCode
    s = sandboxClaimInvoice(s, 1, 'WRONG-REF-CODE', SANDBOX_ACTORS.contractorPayee).state;
    // 5. Verified CoP claim on Invoice #1 -> SETTLED!
    s = sandboxClaimInvoice(s, 1, 'INV-2026-Q4-8841', SANDBOX_ACTORS.contractorPayee).state;

    setSandbox(s);
    setMode('sandbox');
    setStatusBanner({
      ok: true,
      text: 'Guided 5-step security demo executed: 2 valid settlements + 3 on-chain guardrail blocks logged in Audit Feed.',
    });
  };

  const handleCreateSession = async () => {
    try {
      if (!isAddress(sessAgent)) throw new Error('Invalid agent address');
      const perTxLimit = parseTusd8(sessPerTx);
      const dailyLimit = parseTusd8(sessDaily);
      const totalBudget = parseTusd8(sessBudget);
      const durationDays = Math.max(1, Number(sessDays) || 7);

      if (mode === 'sandbox') {
        const res = sandboxCreateSession(sandbox, {
          label: sessLabel,
          agent: sessAgent as Address,
          perTxLimit,
          dailyLimit,
          totalBudget,
          durationDays,
          enforceAllowlist: sessEnforceAllow,
          allowlist: [SANDBOX_ACTORS.cloudVendor, SANDBOX_ACTORS.contractorPayee],
        });
        setSandbox(res.state);
        setStatusBanner({ ok: res.ok, text: res.message });
      } else {
        if (!walletInfo) throw new Error('Connect MetaMask/Rabby to QDay Aevum first.');
        if (!isAddress(vaultAddressInput)) throw new Error('Enter deployed AevumPolicyPayVault address first.');
        setBusy(true);
        const validUntil = BigInt(Math.floor(Date.now() / 1000) + durationDays * 86_400);
        const { approveTx, createTx } = await liveApproveAndCreateSession({
          account: walletInfo.account,
          vaultAddress: vaultAddressInput as Address,
          agent: sessAgent as Address,
          perTxLimit,
          dailyLimit,
          totalBudget,
          validUntil,
          enforceAllowlist: sessEnforceAllow,
          allowlist: [SANDBOX_ACTORS.cloudVendor, SANDBOX_ACTORS.contractorPayee],
          label: sessLabel,
        });
        setLiveTxLinks((prev) => [
          { label: 'createSessionWithDeposit', hash: createTx },
          { label: 'tUSD8.approve', hash: approveTx },
          ...prev,
        ]);
        await handleRefreshLiveVault();
        setStatusBanner({ ok: true, text: `Live session created on QDay Aevum! Tx: ${createTx.slice(0, 12)}…` });
      }
    } catch (err) {
      setStatusBanner({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const handleExecuteSandboxPayment = (override?: { recipient?: Address; amount?: string; memo?: string }) => {
    try {
      const recipient = (override?.recipient ?? payRecipient) as Address;
      if (!isAddress(recipient)) throw new Error('Invalid recipient address');
      const amount = parseTusd8(override?.amount ?? payAmount);
      const res = sandboxExecuteAgentPayment(sandbox, {
        sessionId: paySessionId,
        recipient,
        amount,
        memo: override?.memo ?? payMemo,
        viaSignature: payViaSig,
      });
      setSandbox(res.state);
      setStatusBanner({ ok: res.ok, text: res.message });
    } catch (err) {
      setStatusBanner({ ok: false, text: err instanceof Error ? err.message : String(err) });
    }
  };

  const handleStageSandboxInvoice = () => {
    try {
      if (!isAddress(invPayee)) throw new Error('Invalid payee address');
      if (!invCode.trim()) throw new Error('Confirmation code required');
      const amount = parseTusd8(invAmount);
      const res = sandboxStageInvoice(sandbox, {
        sessionId: invSourceSession,
        payee: invPayee as Address,
        amount,
        confirmationCode: invCode.trim(),
        expiryHours: Math.max(1, Number(invExpiryHrs) || 24),
        invoiceURI: invUri,
      });
      setSandbox(res.state);
      if (res.ok) {
        const newId = res.state.nextInvoiceId - 1;
        setClaimCodes((prev) => ({ ...prev, [newId]: invCode.trim() }));
      }
      setStatusBanner({ ok: res.ok, text: res.message });
    } catch (err) {
      setStatusBanner({ ok: false, text: err instanceof Error ? err.message : String(err) });
    }
  };

  const handleLiveClaim = async () => {
    try {
      if (!walletInfo) throw new Error('Connect wallet first.');
      if (!isAddress(vaultAddressInput)) throw new Error('Enter deployed vault address.');
      setBusy(true);
      const hash = await liveConfirmAndClaimInvoice({
        account: walletInfo.account,
        vaultAddress: vaultAddressInput as Address,
        invoiceId: BigInt(liveClaimId),
        confirmationCode: liveClaimCode.trim(),
      });
      setLiveTxLinks((prev) => [{ label: `confirmAndClaimInvoice(#${liveClaimId})`, hash }, ...prev]);
      await handleRefreshLiveVault();
      setStatusBanner({ ok: true, text: `Invoice #${liveClaimId} claimed on Aevum Testnet!` });
    } catch (err) {
      setStatusBanner({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="app-shell">
      {/* Top Bar */}
      <header className="topbar">
        <div className="brand">
          <div className="brand-badge">
            <Shield size={22} />
          </div>
          <div>
            <h1>Aevum PolicyPay</h1>
            <p>Scoped AI Agent Payments &amp; Confirmation-of-Payee Escrow · tUSD8 on QDay Aevum</p>
          </div>
        </div>

        <div className="mode-bar">
          <span className={`pill ${telemetry?.connected ? 'live' : 'warn'}`}>
            <Activity size={13} />
            {telemetry?.connected
              ? `Aevum #${telemetry.chainId} · Block ${telemetry.blockNumber.toString()}`
              : 'Connecting to rpc-test.qday.info…'}
          </span>

          <div className="seg-toggle" role="tablist" aria-label="Execution Mode">
            <button
              className={mode === 'sandbox' ? 'active' : ''}
              onClick={() => setMode('sandbox')}
            >
              Interactive Sandbox
            </button>
            <button className={mode === 'live' ? 'active' : ''} onClick={() => setMode('live')}>
              Aevum Live Wallet
            </button>
          </div>

          <button className="btn btn-primary" onClick={handleConnectWallet} disabled={busy}>
            <Wallet size={15} />
            {walletInfo
              ? `${walletInfo.account.slice(0, 6)}…${walletInfo.account.slice(-4)}`
              : 'Connect Aevum (44005)'}
          </button>
        </div>
      </header>

      {/* Guided Action & Status Banner */}
      {statusBanner && (
        <div className={`banner ${statusBanner.ok ? 'ok' : 'err'}`}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {statusBanner.ok ? <CheckCircle2 size={17} /> : <ShieldAlert size={17} />}
            {statusBanner.text}
          </span>
          <button className="btn" onClick={() => setStatusBanner(null)}>
            Dismiss
          </button>
        </div>
      )}

      {/* Live Vault Loader when in Live Mode */}
      {mode === 'live' && (
        <div className="card">
          <div className="card-header">
            <h2>
              <Wallet size={17} /> QDay Aevum Testnet Contract Console (Chain ID {AEVUM_CHAIN_ID})
            </h2>
            <div style={{ display: 'flex', gap: 10, fontSize: '0.82rem' }}>
              <a href={AEVUM_FAUCET_URL} target="_blank" rel="noreferrer">
                Claim Free tQDAY &amp; tUSD8 <ExternalLink size={12} />
              </a>
              <a href={explorerAddressUrl(LIVE_TUSD8_ADDRESS)} target="_blank" rel="noreferrer">
                tUSD8 Explorer <ExternalLink size={12} />
              </a>
            </div>
          </div>
          <div className="form-grid">
            <div className="form-row">
              <label>Deployed AevumPolicyPayVault Address</label>
              <input
                value={vaultAddressInput}
                onChange={(e) => setVaultAddressInput(e.target.value)}
                placeholder="0x... (output of `PRIVATE_KEY=... pnpm deploy:aevum`)"
              />
            </div>
            <div className="form-row" style={{ justifyContent: 'flex-end' }}>
              <label>Connected Wallet Balances</label>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span className="pill">
                  {walletInfo
                    ? `${walletInfo.tQdayBalance} tQDAY · ${walletInfo.tUsd8Balance} tUSD8`
                    : 'Not connected'}
                </span>
                <button className="btn" onClick={handleRefreshLiveVault} disabled={busy}>
                  <RefreshCw size={14} /> Sync Vault
                </button>
              </div>
            </div>
          </div>
          {liveTxLinks.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <div className="muted" style={{ marginBottom: 6 }}>
                Recent Verified Aevum Transactions:
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {liveTxLinks.map((tx) => (
                  <a
                    key={tx.hash}
                    href={explorerTxUrl(tx.hash)}
                    target="_blank"
                    rel="noreferrer"
                    className="pill live"
                  >
                    {tx.label}: {tx.hash.slice(0, 10)}… <ExternalLink size={11} />
                  </a>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* KPI & Solvency Conservation Bar */}
      <section className="kpi-grid">
        <div className="kpi-card">
          <div className="kpi-label">Vault Total tUSD8 Solvency</div>
          <div className="kpi-value">
            {mode === 'live' && liveSnapshot
              ? fmtTusd8(
                  liveSnapshot.totalAvailableLiquidity +
                    liveSnapshot.totalSessionUnspent +
                    liveSnapshot.totalEscrowedInvoices
                )
              : fmtTusd8(solvency.vaultTotal)}{' '}
            tUSD8
          </div>
          <div className="kpi-sub">100% invariant: Available + Sessions + CoP Escrow</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">AI Agent Reserved Budget</div>
          <div className="kpi-value">
            {mode === 'live' && liveSnapshot
              ? fmtTusd8(liveSnapshot.totalSessionUnspent)
              : fmtTusd8(solvency.sessionUnspent)}{' '}
            tUSD8
          </div>
          <div className="kpi-sub">
            {mode === 'live' && liveSnapshot
              ? `${(liveSnapshot.nextSessionId - 1n).toString()} on-chain sessions`
              : `${sandbox.sessions.filter((s) => s.active).length} active sandbox session(s)`}
          </div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">CoP Escrowed Invoices</div>
          <div className="kpi-value">
            {mode === 'live' && liveSnapshot
              ? fmtTusd8(liveSnapshot.totalEscrowedInvoices)
              : fmtTusd8(solvency.escrowedInvoices)}{' '}
            tUSD8
          </div>
          <div className="kpi-sub">Locked until Payee confirms reference hash</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">Payer Treasury Liquidity</div>
          <div className="kpi-value">
            {mode === 'live' && liveSnapshot
              ? fmtTusd8(liveSnapshot.payerAvailable)
              : fmtTusd8(solvency.available)}{' '}
            tUSD8
          </div>
          <div className="kpi-sub">
            {mode === 'sandbox'
              ? `Wallet: ${fmtTusd8(sandbox.payerWalletBalance)} tUSD8`
              : `tUSD8 Supply: ${telemetry?.tokenTotalSupply ?? '—'}`}
          </div>
        </div>
      </section>

      {/* Quick Judge Controls (Sandbox) */}
      {mode === 'sandbox' && (
        <div
          className="card"
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            padding: '12px 16px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span className="pill warn">
              <Clock size={13} /> Sandbox Clock: {new Date(sandbox.nowSec * 1000).toISOString().slice(0, 16)} UTC
            </span>
            <button
              className="btn"
              onClick={() =>
                setSandbox((s) => ({
                  ...s,
                  nowSec: s.nowSec + 12 * 3600,
                }))
              }
            >
              +12h Time Warp
            </button>
            <button
              className="btn"
              onClick={() =>
                setSandbox((s) => ({
                  ...s,
                  nowSec: s.nowSec + 24 * 3600,
                }))
              }
            >
              +24h Reset Rolling Window
            </button>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-primary" onClick={handleGuidedDemo}>
              <Play size={14} /> Run 30s Attack &amp; CoP Guided Demo
            </button>
            <button
              className="btn"
              onClick={() => {
                setSandbox(createInitialSandboxState());
                setStatusBanner({ ok: true, text: 'Sandbox reset to clean initial state.' });
              }}
            >
              Reset
            </button>
          </div>
        </div>
      )}

      {/* Navigation Tabs */}
      <nav className="tabs">
        <button className={`tab-btn ${tab === 'agent' ? 'active' : ''}`} onClick={() => setTab('agent')}>
          <Bot size={16} /> 1. AI Agent Policies &amp; Guardrails
        </button>
        <button className={`tab-btn ${tab === 'cop' ? 'active' : ''}`} onClick={() => setTab('cop')}>
          <FileCheck2 size={16} /> 2. Confirmation-of-Payee Escrow
        </button>
        <button className={`tab-btn ${tab === 'audit' ? 'active' : ''}`} onClick={() => setTab('audit')}>
          <Shield size={16} /> 3. Audit Log &amp; Live Aevum Telemetry
        </button>
      </nav>

      {/* TAB 1: AI AGENT POLICIES */}
      {tab === 'agent' && (
        <div className="grid-2">
          <div>
            <div className="card">
              <div className="card-header">
                <h2>
                  <Bot size={17} /> Active Scoped Agent Sessions
                </h2>
                <span className="muted">Enforced on-chain by AevumPolicyPayVault.sol</span>
              </div>

              {sandbox.sessions.map((s) => {
                const rolling = getRolling24hSpent(s, sandbox.nowSec);
                const dailyPct = Math.min(100, Number((rolling * 100n) / (s.dailyLimit || 1n)));
                const totalPct = Math.min(100, Number((s.spentTotal * 100n) / (s.totalBudget || 1n)));
                const expired = sandbox.nowSec > s.validUntil;

                return (
                  <div key={s.id} className="session-item">
                    <div className="card-header" style={{ marginBottom: 8 }}>
                      <div>
                        <strong>
                          #{s.id} {s.label}
                        </strong>
                        <div className="mono muted">Agent: {s.agent}</div>
                      </div>
                      <span
                        className={`pill ${
                          !s.active || expired ? 'danger' : s.paused ? 'warn' : 'live'
                        }`}
                      >
                        {!s.active ? 'REVOKED' : expired ? 'EXPIRED' : s.paused ? 'PAUSED' : 'ACTIVE'} · Nonce {s.nonce}
                      </span>
                    </div>

                    <div className="form-grid" style={{ marginTop: 8 }}>
                      <div>
                        <div className="muted">
                          Rolling 24h: {fmtTusd8(rolling)} / {fmtTusd8(s.dailyLimit)} tUSD8
                        </div>
                        <div className="progress-track">
                          <div
                            className={`progress-fill ${dailyPct >= 85 ? 'warn' : ''}`}
                            style={{ width: `${dailyPct}%` }}
                          />
                        </div>
                      </div>
                      <div>
                        <div className="muted">
                          Total Budget: {fmtTusd8(s.spentTotal)} / {fmtTusd8(s.totalBudget)} tUSD8
                        </div>
                        <div className="progress-track">
                          <div
                            className={`progress-fill ${totalPct >= 85 ? 'warn' : ''}`}
                            style={{ width: `${totalPct}%` }}
                          />
                        </div>
                      </div>
                    </div>

                    <div className="muted" style={{ marginTop: 8 }}>
                      Per-Tx Cap: <strong>{fmtTusd8(s.perTxLimit)} tUSD8</strong> · Allowlist:{' '}
                      <strong>{s.enforceAllowlist ? `${s.allowlist.length} verified vendors` : 'Open'}</strong>
                    </div>

                    {s.active && (
                      <div className="row-actions">
                        <button
                          className="btn btn-amber"
                          onClick={() => setSandbox((prev) => sandboxTogglePauseSession(prev, s.id))}
                        >
                          {s.paused ? 'Resume Session' : 'Pause Session'}
                        </button>
                        <button
                          className="btn btn-danger"
                          onClick={() => {
                            setSandbox((prev) => sandboxRevokeSession(prev, s.id));
                            setStatusBanner({
                              ok: true,
                              text: `Session #${s.id} revoked — remaining budget returned to treasury.`,
                            });
                          }}
                        >
                          <XCircle size={14} /> Kill Switch &amp; Refund
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Create New Session Policy */}
            <div className="card">
              <div className="card-header">
                <h2>
                  <Lock size={17} /> Grant New AI Agent Policy Session
                </h2>
                <span className="pill">{mode === 'live' ? 'Writes to Aevum Testnet' : 'Sandbox Mode'}</span>
              </div>
              <div className="form-row">
                <label>Policy Role Label</label>
                <input value={sessLabel} onChange={(e) => setSessLabel(e.target.value)} />
              </div>
              <div className="form-row">
                <label>Scoped AI Agent Signer Address</label>
                <input className="mono" value={sessAgent} onChange={(e) => setSessAgent(e.target.value)} />
              </div>
              <div className="form-grid">
                <div className="form-row">
                  <label>Per-Tx Cap (tUSD8)</label>
                  <input value={sessPerTx} onChange={(e) => setSessPerTx(e.target.value)} />
                </div>
                <div className="form-row">
                  <label>Rolling 24h Cap (tUSD8)</label>
                  <input value={sessDaily} onChange={(e) => setSessDaily(e.target.value)} />
                </div>
                <div className="form-row">
                  <label>Total Reserved Budget (tUSD8)</label>
                  <input value={sessBudget} onChange={(e) => setSessBudget(e.target.value)} />
                </div>
                <div className="form-row">
                  <label>Expiry (Days)</label>
                  <input value={sessDays} onChange={(e) => setSessDays(e.target.value)} />
                </div>
              </div>
              <div className="row-actions" style={{ alignItems: 'center', justifyContent: 'space-between' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.82rem' }}>
                  <input
                    type="checkbox"
                    style={{ width: 'auto' }}
                    checked={sessEnforceAllow}
                    onChange={(e) => setSessEnforceAllow(e.target.checked)}
                  />
                  Enforce Vendor Allowlist
                </label>
                <button className="btn btn-primary" onClick={handleCreateSession} disabled={busy}>
                  Approve &amp; Create Session
                </button>
              </div>
            </div>
          </div>

          {/* Right Column: Execute Payment & Guardrail Attack Simulator */}
          <div>
            <div className="card">
              <div className="card-header">
                <h2>
                  <AlertTriangle size={17} /> AI Agent Execution &amp; Guardrail Simulator
                </h2>
              </div>

              <div className="form-grid">
                <div className="form-row">
                  <label>Session ID</label>
                  <select
                    value={paySessionId}
                    onChange={(e) => setPaySessionId(Number(e.target.value))}
                  >
                    {sandbox.sessions.map((s) => (
                      <option key={s.id} value={s.id}>
                        #{s.id} {s.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="form-row">
                  <label>Amount (tUSD8)</label>
                  <input value={payAmount} onChange={(e) => setPayAmount(e.target.value)} />
                </div>
              </div>

              <div className="form-row">
                <label>Recipient Address</label>
                <select value={payRecipient} onChange={(e) => setPayRecipient(e.target.value)}>
                  <option value={SANDBOX_ACTORS.cloudVendor}>
                    Verified Cloud API Vendor ({SANDBOX_ACTORS.cloudVendor.slice(0, 10)}…)
                  </option>
                  <option value={SANDBOX_ACTORS.contractorPayee}>
                    Verified Contractor Payee ({SANDBOX_ACTORS.contractorPayee.slice(0, 10)}…)
                  </option>
                  <option value={SANDBOX_ACTORS.rogueAddress}>
                    Unapproved Rogue Address ({SANDBOX_ACTORS.rogueAddress.slice(0, 10)}…)
                  </option>
                </select>
              </div>

              <div className="form-row">
                <label>Payment Memo (keccak256 hashed on-chain)</label>
                <input value={payMemo} onChange={(e) => setPayMemo(e.target.value)} />
              </div>

              <div className="row-actions" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.82rem' }}>
                  <input
                    type="checkbox"
                    style={{ width: 'auto' }}
                    checked={payViaSig}
                    onChange={(e) => setPayViaSig(e.target.checked)}
                  />
                  Gasless EIP-712 Relayed Signature
                </label>
                <button className="btn btn-primary" onClick={() => handleExecuteSandboxPayment()}>
                  Execute Agent Payment
                </button>
              </div>

              <hr style={{ borderColor: 'var(--border)', margin: '16px 0' }} />
              <div className="muted" style={{ marginBottom: 8 }}>
                <strong>1-Click Red-Team Guardrail Tests</strong> (proves on-chain enforcement):
              </div>
              <div className="row-actions">
                <button
                  className="btn btn-danger"
                  onClick={() =>
                    handleExecuteSandboxPayment({
                      recipient: SANDBOX_ACTORS.cloudVendor,
                      amount: '60',
                      memo: 'attack-per-tx-overspend',
                    })
                  }
                >
                  Trigger 60 tUSD8 Overspend (Blocked)
                </button>
                <button
                  className="btn btn-danger"
                  onClick={() =>
                    handleExecuteSandboxPayment({
                      recipient: SANDBOX_ACTORS.rogueAddress,
                      amount: '10',
                      memo: 'attack-prompt-injection-exfil',
                    })
                  }
                >
                  Trigger Unlisted Address Drain (Blocked)
                </button>
              </div>
            </div>

            {/* Compact Live Audit Preview */}
            <div className="card">
              <div className="card-header">
                <h2>Recent Guardrail &amp; Settlement Feed</h2>
              </div>
              <div className="audit-list">
                {sandbox.auditLog.slice(0, 6).map((item) => (
                  <div key={item.id} className={`audit-item ${item.kind}`}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                      <strong>{item.title}</strong>
                      {item.errorCode && <span className="pill danger">{item.errorCode}()</span>}
                    </div>
                    <div className="muted" style={{ marginTop: 4 }}>
                      {item.detail}
                    </div>
                    {item.digest && (
                      <div className="mono muted" style={{ marginTop: 4 }}>
                        EIP-712 Digest: {item.digest.slice(0, 26)}…
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* TAB 2: CONFIRMATION-OF-PAYEE ESCROW */}
      {tab === 'cop' && (
        <div className="grid-2">
          <div>
            <div className="card">
              <div className="card-header">
                <h2>
                  <FileCheck2 size={17} /> Active Confirmation-of-Payee (CoP) Escrows
                </h2>
                <span className="muted">Zero wrong-address stablecoin burns</span>
              </div>

              {sandbox.invoices.map((inv) => {
                const isExpired = sandbox.nowSec > inv.expiresAt;
                const codeVal = claimCodes[inv.id] ?? '';
                return (
                  <div key={inv.id} className="invoice-item">
                    <div className="card-header" style={{ marginBottom: 6 }}>
                      <strong>
                        Invoice #{inv.id} · {fmtTusd8(inv.amount)} tUSD8
                      </strong>
                      <span
                        className={`pill ${
                          inv.status === 'Claimed'
                            ? 'live'
                            : inv.status === 'Refunded'
                              ? 'warn'
                              : isExpired
                                ? 'danger'
                                : 'warn'
                        }`}
                      >
                        {inv.status === 'Pending' && isExpired ? 'EXPIRED (RECLAIMABLE)' : inv.status.toUpperCase()}
                      </span>
                    </div>

                    <div className="mono muted">Payee: {inv.payee}</div>
                    <div className="mono muted">CoP Hash: {inv.confirmationHash}</div>
                    <div className="muted" style={{ marginTop: 4 }}>
                      Source: {inv.sessionId > 0 ? `AI Agent Session #${inv.sessionId}` : 'Direct Payer Treasury'} · URI:{' '}
                      {inv.invoiceURI}
                    </div>

                    {inv.status === 'Pending' && (
                      <div style={{ marginTop: 10 }}>
                        <div className="form-row">
                          <label>
                            Payee Confirmation Reference Code{' '}
                            {inv.hintCode && <span className="muted">(demo code: {inv.hintCode})</span>}
                          </label>
                          <input
                            value={codeVal}
                            onChange={(e) =>
                              setClaimCodes((prev) => ({ ...prev, [inv.id]: e.target.value }))
                            }
                            placeholder="Enter secret confirmation code"
                          />
                        </div>
                        <div className="row-actions">
                          <button
                            className="btn btn-primary"
                            onClick={() => {
                              const res = sandboxClaimInvoice(sandbox, inv.id, codeVal, inv.payee);
                              setSandbox(res.state);
                              setStatusBanner({ ok: res.ok, text: res.message });
                            }}
                          >
                            Confirm &amp; Claim as Payee
                          </button>
                          <button
                            className="btn btn-danger"
                            onClick={() => {
                              const res = sandboxClaimInvoice(sandbox, inv.id, 'WRONG-CODE-000', inv.payee);
                              setSandbox(res.state);
                              setStatusBanner({ ok: res.ok, text: res.message });
                            }}
                          >
                            Test Wrong Code (Blocked)
                          </button>
                          <button
                            className="btn btn-amber"
                            onClick={() => {
                              const res = sandboxReclaimInvoice(sandbox, inv.id);
                              setSandbox(res.state);
                              setStatusBanner({ ok: res.ok, text: res.message });
                            }}
                          >
                            Reclaim Expired Escrow
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          <div>
            <div className="card">
              <div className="card-header">
                <h2>Stage New CoP Invoice / Payroll Escrow</h2>
              </div>
              <div className="form-grid">
                <div className="form-row">
                  <label>Funding Source</label>
                  <select
                    value={invSourceSession}
                    onChange={(e) => setInvSourceSession(Number(e.target.value))}
                  >
                    <option value={0}>Direct Payer Treasury</option>
                    {sandbox.sessions.map((s) => (
                      <option key={s.id} value={s.id}>
                        AI Agent Session #{s.id} ({s.label})
                      </option>
                    ))}
                  </select>
                </div>
                <div className="form-row">
                  <label>Escrow Amount (tUSD8)</label>
                  <input value={invAmount} onChange={(e) => setInvAmount(e.target.value)} />
                </div>
              </div>

              <div className="form-row">
                <label>Intended Payee Address</label>
                <select value={invPayee} onChange={(e) => setInvPayee(e.target.value)}>
                  <option value={SANDBOX_ACTORS.contractorPayee}>
                    Verified Contractor ({SANDBOX_ACTORS.contractorPayee})
                  </option>
                  <option value={SANDBOX_ACTORS.cloudVendor}>
                    Verified Cloud Vendor ({SANDBOX_ACTORS.cloudVendor})
                  </option>
                  <option value={SANDBOX_ACTORS.rogueAddress}>
                    Unlisted Address ({SANDBOX_ACTORS.rogueAddress})
                  </option>
                </select>
              </div>

              <div className="form-grid">
                <div className="form-row">
                  <label>Out-of-Band CoP Reference Code</label>
                  <input value={invCode} onChange={(e) => setInvCode(e.target.value)} />
                </div>
                <div className="form-row">
                  <label>Claim Window (Hours)</label>
                  <input value={invExpiryHrs} onChange={(e) => setInvExpiryHrs(e.target.value)} />
                </div>
              </div>

              <div className="form-row">
                <label>Invoice Metadata URI</label>
                <input value={invUri} onChange={(e) => setInvUri(e.target.value)} />
              </div>

              <div className="audit-item event" style={{ marginBottom: 12 }}>
                <div className="muted">Computed On-Chain Confirmation Hash: keccak256(abi.encode(payee, code))</div>
                <div className="mono" style={{ marginTop: 4 }}>
                  {previewCoPHash}
                </div>
              </div>

              <button className="btn btn-primary" onClick={handleStageSandboxInvoice}>
                Escrow tUSD8 with Confirmation-of-Payee
              </button>
            </div>

            {mode === 'live' && (
              <div className="card">
                <div className="card-header">
                  <h2>Live Aevum Payee Claim Terminal</h2>
                </div>
                <div className="form-grid">
                  <div className="form-row">
                    <label>On-Chain Invoice ID</label>
                    <input value={liveClaimId} onChange={(e) => setLiveClaimId(e.target.value)} />
                  </div>
                  <div className="form-row">
                    <label>Confirmation Code</label>
                    <input value={liveClaimCode} onChange={(e) => setLiveClaimCode(e.target.value)} />
                  </div>
                </div>
                <button className="btn btn-primary" onClick={handleLiveClaim} disabled={busy}>
                  Submit confirmAndClaimInvoice on Aevum
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* TAB 3: AUDIT & LIVE AEVUM TELEMETRY */}
      {tab === 'audit' && (
        <div className="grid-2">
          <div className="card">
            <div className="card-header">
              <h2>Full Event &amp; Blocked-Violation Audit Trail</h2>
              <span className="pill">{sandbox.auditLog.length} records</span>
            </div>
            <div className="audit-list">
              {sandbox.auditLog.map((item) => (
                <div key={item.id} className={`audit-item ${item.kind}`}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                    <strong>{item.title}</strong>
                    <span className={`pill ${item.kind === 'blocked' ? 'danger' : 'live'}`}>
                      {item.errorCode ? `${item.errorCode}()` : 'SETTLED'}
                    </span>
                  </div>
                  <div className="muted" style={{ marginTop: 4 }}>
                    {item.detail}
                  </div>
                  {item.digest && (
                    <div className="mono muted" style={{ marginTop: 4 }}>
                      EIP-712 Digest: {item.digest}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>

          <div className="card">
            <div className="card-header">
              <h2>Live QDay Aevum Testnet Verification</h2>
              <button className="btn" onClick={refreshTelemetry}>
                <RefreshCw size={14} /> Refresh RPC
              </button>
            </div>
            <div className="audit-list">
              <div className="audit-item">
                <div className="muted">Network / Chain ID</div>
                <div className="mono">
                  QDay Aevum Testnet · Chain ID {telemetry?.chainId ?? AEVUM_CHAIN_ID} (0xabe5)
                </div>
              </div>
              <div className="audit-item">
                <div className="muted">Live RPC Endpoint</div>
                <div className="mono">{AEVUM_RPC_URL}</div>
              </div>
              <div className="audit-item">
                <div className="muted">Live Block Height &amp; Gas Price</div>
                <div className="mono">
                  Block #{telemetry?.blockNumber.toString() ?? '—'} · {telemetry?.gasPriceGwei ?? '—'} Gwei
                </div>
              </div>
              <div className="audit-item">
                <div className="muted">Official Live tUSD8 Contract (ERC-20, 6 decimals)</div>
                <div className="mono">
                  <a href={explorerAddressUrl(LIVE_TUSD8_ADDRESS)} target="_blank" rel="noreferrer">
                    {LIVE_TUSD8_ADDRESS}
                  </a>
                </div>
                <div className="muted" style={{ marginTop: 4 }}>
                  Symbol: {telemetry?.tokenSymbol ?? 'tUSD8'} · Total Supply:{' '}
                  {telemetry?.tokenTotalSupply ?? '—'} tUSD8
                </div>
              </div>
              <div className="audit-item">
                <div className="muted">Official Resources</div>
                <div className="row-actions">
                  <a className="btn" href={AEVUM_FAUCET_URL} target="_blank" rel="noreferrer">
                    Aevum Faucet <ExternalLink size={13} />
                  </a>
                  <a className="btn" href={AEVUM_EXPLORER_URL} target="_blank" rel="noreferrer">
                    Aevum Explorer <ExternalLink size={13} />
                  </a>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
