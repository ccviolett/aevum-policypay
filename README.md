# Aevum PolicyPay

**Policy-Controlled AI Agent Session Payments & Confirmation-of-Payee (CoP) Invoice Escrow in `tUSD8` on QDay Aevum Testnet (Chain ID `44005`).**

Built for **QDay — Aevum Builder Challenge #1 (Stablecoin Payments)**.

---

## Problem Statement

Two critical trust barriers block real-world stablecoin payments today:

1. **Unbounded AI Agent Keys**: Handing a raw wallet private key to an autonomous AI payment agent means a single prompt injection or model hallucination can drain the entire treasury in one transaction. Off-chain prompt guardrails are bypassable.
2. **Irreversible Wrong-Address Transfers**: In B2B invoicing and contractor payroll, mistyping a single address character permanently burns `tUSD8`.

**Aevum PolicyPay** solves both in one cohesive, non-custodial smart contract (`contracts/AevumPolicyPayVault.sol`) paired with a one-command Aevum deployment/proof CLI and an interactive React + `viem` web studio.

---

## Core Payment Flow (End-to-End)

1. **Fund & Scope an AI Agent Policy**: A treasury payer approves `tUSD8` and calls `createSessionWithDeposit(...)`, reserving a bounded budget with on-chain limits:
   - `perTxLimit` — maximum `tUSD8` per execution
   - `dailyLimit` — **rolling 24-hour** spending cap (24 one-hour sliding buckets, preventing UTC-midnight double-spend attacks)
   - `totalBudget` — hard reserved budget cap
   - `validUntil` — automatic timestamp expiry
   - `enforceAllowlist` — optional verified vendor/recipient allowlist
   - Instant `setSessionPaused` / `revokeSessionAndWithdraw` kill switch (works even during global emergency pause)
2. **Direct or Gasless EIP-712 Agent Settlement**:
   - The AI agent executes directly (`executeAgentPayment`) or signs an EIP-712 typed intent (`AgentPayment` bound to Chain ID `44005`, `verifyingContract`, `deadline`, and strict monotonic `nonce`) submitted by any relayer (`executeAgentPaymentWithSig`).
   - Any overspend, unapproved address, replayed nonce, malleable `s`, or expired session reverts deterministically at the EVM level.
3. **Confirmation-of-Payee (CoP) Invoice & Payroll Escrow**:
   - Either the payer (`createInvoiceByPayer`) or a policy-bounded AI agent (`createInvoiceByAgent` / `createInvoiceByAgentWithSig`) escrows `tUSD8` with `confirmationHash = keccak256(abi.encode(payee, confirmationCode))`.
   - The designated payee confirms their address + out-of-band invoice reference via `confirmAndClaimInvoice(invoiceId, confirmationCode)` to settle instantly.
   - Wrong payees or wrong codes revert; if unclaimed past `expiresAt` (e.g., typo'd address), the payer reclaims 100% via `reclaimExpiredInvoice(invoiceId)`.

---

## Live QDay Aevum Testnet Configuration (Verified)

| Parameter | Verified Live Value |
| --- | --- |
| **Network** | QDay Aevum Testnet |
| **Chain ID** | `44005` (`0xabe5`) |
| **RPC Endpoint** | `https://rpc-test.qday.info` |
| **Block Explorer** | `https://explorer-test.qday.info` |
| **Testnet Faucet** | `https://faucet.qday.info/en` |
| **Native Gas Token** | `tQDAY` (18 decimals) |
| **Official `tUSD8` Contract** | `0x456569838f1d43009A91ebA4263147Afd7233483` (`tUSD8`, 6 decimals) |
| **EVM Compatibility Target** | Shanghai (`solc 0.8.28`, optimizer 200 runs, **0 warnings**) |
| **Live `eth_estimateGas` (Vault Deploy)** | `3,860,390` gas (~`0.00386 tQDAY` at `1 Gwei`) |

---

## Repository Structure

```text
.
├── contracts/
│   ├── AevumPolicyPayVault.sol      # Production policy vault + CoP escrow (Solidity ^0.8.24)
│   └── test/MockTUSD8.sol           # Strictly local unit-test ERC-20 mock (never deployed to testnet)
├── shared/
│   ├── aevum.ts                     # Verified QDay Aevum Chain ID 44005 & tUSD8 config + EIP-712 types
│   └── generated/                   # Auto-generated typed ABI + bytecode from scripts/compile.ts
├── scripts/
│   ├── compile.ts                   # Strict zero-warning solc compiler (Shanghai EVM)
│   └── deploy-aevum.ts              # Live RPC verifier (--dry-run) + 8-tx live Aevum E2E proof deployer
├── test/
│   ├── evmHarness.ts                # Real EthereumJS VM harness (Chain ID 44005, Shanghai hardfork)
│   ├── AevumPolicyPayVault.test.ts  # Security, EIP-712, rolling 24h, CoP & 60-step solvency fuzz suite
│   └── policyEngine.test.ts         # Frontend sandbox parity tests against compiled Solidity contract
├── frontend/                        # React 19 + Vite + TypeScript + viem Web Console
├── docker/nginx.conf                # Static SPA config for Docker runtime stage
├── Dockerfile                       # Multi-stage Node 22 + Nginx Alpine container
├── docker-compose.yml               # One-command containerized launch (port 8080)
├── ARCHITECTURE.md                  # Mermaid system, sequence, state diagrams & security invariants
├── DEMO_SCRIPT_3MIN.md              # Timed 3-minute script for Top-5 Live Demo Day
└── USER_ACTION_NEEDED.md            # Submission & testnet deployment checklist
```

---

## Quick Start

### 1. Install, Compile (0 Warnings), and Run Automated EVM Test Suite

```bash
pnpm install
pnpm compile
pnpm test
pnpm typecheck
pnpm build
```

All 10 test suites run real compiled Solidity bytecode on an in-memory Shanghai EVM configured to **Chain ID `44005`**, verifying:
- Constructor & token contract validation + Chain ID `44005` EIP-712 domain separation
- Per-tx cap strict boundary (`perTxLimit` passes, `perTxLimit + 1` reverts `PerTxLimitExceeded`)
- True rolling 24-hour window (`+23h` still enforces cap, `+24h` rolls off hour-by-hour)
- Gasless relayed EIP-712 signatures, replay nonce blocking, tampering detection, deadline expiry, and ECDSA high-`s` malleability rejection
- Total budget caps, `topUpSession`, `getSessionRemainingAllowance`, and `revokeSessionAndWithdraw`
- Vendor allowlist, session expiry, session pause, global emergency pause + safe non-custodial escape hatches
- Full Confirmation-of-Payee (CoP) lifecycle: agent EIP-712 staging, wrong-payee block, wrong-code block, verified claim, double-claim block, early-reclaim block, expired reclaim, and payee rejection
- 60-step deterministic randomized fuzz suite enforcing exact solvency conservation (`tUSD8.balanceOf(vault) == totalAvailableLiquidity + totalSessionUnspent + totalEscrowedInvoices`) on every step
- Cryptographic hash parity between the frontend Sandbox PolicyEngine and compiled Solidity `computeConfirmationHash()`

### 2. Verify Live QDay Aevum RPC & `tUSD8` (`$0` Dry-Run)

```bash
pnpm deploy:dry-run
```

### 3. Deploy & Generate Verified Aevum Testnet Transaction Proofs

1. Claim free `tQDAY` and `tUSD8` from [`https://faucet.qday.info/en`](https://faucet.qday.info/en).
2. Run the automated deployment + 8-transaction live E2E proof script:

```bash
PRIVATE_KEY=0x<YOUR_TESTNET_PRIVATE_KEY> pnpm deploy:aevum
```

This deploys `AevumPolicyPayVault` wired to the live `tUSD8` contract (`0x456569838f1d43009A91ebA4263147Afd7233483`), executes live session funding, EIP-712 agent payment, EIP-712 CoP invoice staging, payee CoP claim, and session revocation, and generates `DEPLOYMENT_RECEIPT.md` with clickable `explorer-test.qday.info` links.

### 4. Launch Web UI (Local or Docker)

```bash
# Local Vite dev server (supports both Interactive Sandbox Mode and Live MetaMask/Rabby Aevum Wallet)
VITE_VAULT_ADDRESS=0x<DEPLOYED_VAULT_ADDRESS> pnpm dev

# Or one-command Docker container on http://localhost:8080
VITE_VAULT_ADDRESS=0x<DEPLOYED_VAULT_ADDRESS> docker compose up --build
```

---

## Documentation

- [ARCHITECTURE.md](./ARCHITECTURE.md) — Mermaid architecture, sequence & state diagrams, and security invariants
- [DEMO_SCRIPT_3MIN.md](./DEMO_SCRIPT_3MIN.md) — Timed live demo walkthrough for Demo Day (`2026-12-15 06:00 UTC / 14:00 HKT`)

## License

MIT
