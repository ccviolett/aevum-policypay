# Live Demo Day Script (3 Minutes) — QDay Aevum Builder Challenge #1

- **Target Event**: Top-5 Live Demo Day — **December 15, 2026 at 06:00 UTC (14:00 HKT)**
- **Format**: 3–5 minute live presentation + screen share (attendance required; no pre-recorded replacement)
- **Setup Before Call**:
  1. Open the app locally (`pnpm dev` or `docker compose up`) with `VITE_VAULT_ADDRESS` set to your deployed Aevum Testnet vault address.
  2. Open a second browser tab on `https://explorer-test.qday.info/address/<VAULT_ADDRESS>` showing your verified Aevum Testnet transactions from `DEPLOYMENT_RECEIPT.md`.
  3. Have MetaMask unlocked on **QDay Aevum Testnet (Chain ID `44005`)** with `tQDAY` + `tUSD8` visible.

---

## 0:00 – 0:30 | Hook & Real-World Problem (30s)

> "Hi judges! Stablecoins already settle globally in seconds, yet two huge risks still stop teams from letting **AI agents** and **finance ops** pay autonomously in `tUSD8`:
> 1. **Unbounded AI keys** — one prompt injection or model hallucination can drain a treasury in a single transaction.
> 2. **Irreversible wrong-address sends** — one mistyped contractor or vendor address permanently burns funds.
>
> We built **Aevum PolicyPay** on **QDay Aevum Testnet (Chain ID 44005)** to solve both in one unified `tUSD8` payment vault."

---

## 0:30 – 1:15 | Live Demo Part 1: On-Chain AI Agent Guardrails (45s)

*Screen: App open on Tab 1 (`AI Agent Policies & Guardrails`), pointing to the live Aevum block height badge in the top-right (`Aevum #44005 · Block ...`).*

1. Show the active policy card: **`Ops AI Procurement Agent`** — `25 tUSD8` per-tx cap, `50 tUSD8` **rolling 24-hour** cap, `150 tUSD8` total reserved budget, and a verified vendor allowlist.
2. Click **Execute Agent Payment** (`15 tUSD8`, Gasless EIP-712 Relayed Signature checked) -> settles immediately, updates rolling 24h meter and EIP-712 digest in the Audit Feed.
3. Now click the two red-team buttons:
   - **Trigger 60 tUSD8 Overspend (Blocked)** -> immediately rejected with Solidity custom error **`PerTxLimitExceeded()`**!
   - **Trigger Unlisted Address Drain (Blocked)** -> immediately rejected with **`RecipientNotAllowed()`**!
4. Click **`+24h Reset Rolling Window`** (if showing rolling-window behavior) or point out that our contract uses 24 one-hour sliding buckets instead of naive UTC-midnight resets, preventing boundary double-spends.

> "Crucially, these limits are enforced by `AevumPolicyPayVault.sol` at the EVM level — not by LLM prompts."

---

## 1:15 – 2:05 | Live Demo Part 2: Confirmation-of-Payee (CoP) Escrow (50s)

*Screen: Switch to Tab 2 (`Confirmation-of-Payee Escrow`).*

1. Show **Invoice #1 (`40.00 tUSD8`)** escrowed for a contractor, displaying its on-chain `confirmationHash = keccak256(abi.encode(payee, confirmationCode))`.
2. Click **Test Wrong Code (Blocked)** -> reverts with **`InvalidConfirmationCode()`**; funds remain safely locked in escrow.
3. Click **Confirm & Claim as Payee** with the valid code (`INV-2026-Q4-8841`) -> settles `40.00 tUSD8` to the contractor and updates the top **Vault Total tUSD8 Solvency** bar (`Available + Sessions + CoP Escrow` always conserved to the micro-unit).
4. Mention: if a payer accidentally typed the wrong payee address, nobody can claim without the code, and after `expiresAt` the payer reclaims 100% of funds — even if the contract is globally paused.

---

## 2:05 – 2:45 | Live QDay Aevum Proof & Security Engineering (40s)

*Screen: Switch to Tab 3 (`Audit Log & Live Aevum Telemetry`) and then the Aevum Explorer tab.*

1. Show live RPC connectivity to `https://rpc-test.qday.info` (`Chain ID 44005`) and the official live `tUSD8` contract (`0x456569838f1d43009A91ebA4263147Afd7233483`).
2. Show the verified Aevum Explorer transactions from our one-command E2E proof (`deploy` -> `createSessionWithDeposit` -> `executeAgentPaymentWithSig` -> `createInvoiceByAgentWithSig` -> `confirmAndClaimInvoice` -> `revokeSessionAndWithdraw`).
3. Highlight engineering rigor: **0 Solidity warnings** targeting Aevum's Shanghai EVM, **100% passing automated EVM security & 60-step randomized solvency fuzz tests**, and a one-command **Docker** deployment.

---

## 2:45 – 3:00 | Wrap-Up & Mainnet Roadmap (15s)

> "Because QDay's `@qday-io/sdk` ships in Q1 2027, Aevum PolicyPay gives teams real policy-bounded AI payments and Confirmation-of-Payee `tUSD8` settlement **today**, ready to plug straight into QDay Mainnet, ERC-4337 paymasters, and MCP agent tooling. Happy to take any questions!"
