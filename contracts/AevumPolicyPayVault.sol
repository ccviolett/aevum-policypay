// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20Minimal {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}

/**
 * @title AevumPolicyPayVault
 * @notice Policy-controlled AI Agent payment sessions + Confirmation-of-Payee (CoP)
 *         Invoice/Payroll Escrow for tUSD8 on QDay Aevum Testnet (Chain ID 44005).
 * @dev Designed for Shanghai EVM compatibility (no Cancun-only opcodes), strict CEI,
 *      custom errors, reentrancy protection, SafeERC20-style transfer handling,
 *      EIP-712 delegated signatures, rolling 24-hour spending caps, and exact
 *      on-chain solvency accounting.
 */
contract AevumPolicyPayVault {
    // -------------------------------------------------------------------------
    // Constants
    // -------------------------------------------------------------------------

    uint256 public constant HOUR_SECONDS = 3600;
    uint256 public constant ROLLING_WINDOW_HOURS = 24;

    bytes32 public constant EIP712_DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );
    bytes32 public constant AGENT_PAYMENT_TYPEHASH = keccak256(
        "AgentPayment(uint256 sessionId,address recipient,uint256 amount,uint256 nonce,uint64 deadline,bytes32 memoHash)"
    );
    bytes32 public constant AGENT_INVOICE_TYPEHASH = keccak256(
        "AgentInvoice(uint256 sessionId,address payee,uint256 amount,uint64 expiresAt,bytes32 confirmationHash,uint256 nonce,uint64 deadline)"
    );

    bytes32 private constant _NAME_HASH = keccak256("AevumPolicyPayVault");
    bytes32 private constant _VERSION_HASH = keccak256("1");
    uint256 private constant _SECP256K1N_HALF =
        0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    uint256 private constant _NOT_ENTERED = 1;
    uint256 private constant _ENTERED = 2;

    // -------------------------------------------------------------------------
    // Types
    // -------------------------------------------------------------------------

    enum InvoiceStatus {
        None,
        Pending,
        Claimed,
        Refunded
    }

    struct AgentSession {
        address payer;
        address agent;
        uint128 perTxLimit;
        uint128 dailyLimit;
        uint128 totalBudget;
        uint128 spentTotal;
        uint64 validUntil;
        bool enforceAllowlist;
        bool active;
        bool paused;
        string label;
    }

    struct Invoice {
        address payer;
        address payee;
        uint256 sessionId;
        uint128 amount;
        uint64 createdAt;
        uint64 expiresAt;
        uint64 settledAt;
        InvoiceStatus status;
        bytes32 confirmationHash;
        string invoiceURI;
    }

    // -------------------------------------------------------------------------
    // Immutables & Storage
    // -------------------------------------------------------------------------

    IERC20Minimal public immutable token;
    uint256 private immutable _initialChainId;
    bytes32 private immutable _initialDomainSeparator;

    address public owner;
    bool public paused;
    uint256 private _lockStatus;

    uint256 public nextSessionId;
    uint256 public nextInvoiceId;

    // Explicit solvency accounting: token.balanceOf(this) >= sum of these three
    uint256 public totalAvailableLiquidity;
    uint256 public totalSessionUnspent;
    uint256 public totalEscrowedInvoices;

    mapping(address => uint256) public availableBalance;
    mapping(uint256 => AgentSession) private _sessions;
    mapping(uint256 => uint256) public sessionNonces;
    mapping(uint256 => mapping(address => bool)) public sessionAllowlist;
    mapping(uint256 => mapping(uint256 => uint128)) private _hourlySpend;
    mapping(uint256 => Invoice) private _invoices;

    // -------------------------------------------------------------------------
    // Custom Errors
    // -------------------------------------------------------------------------

    error ZeroAddress();
    error InvalidTokenContract();
    error ZeroAmount();
    error AmountOverflow();
    error Unauthorized();
    error ContractPaused();
    error ReentrancyDetected();
    error InsufficientTreasuryBalance(uint256 available, uint256 required);
    error InvalidPolicyLimits();
    error InvalidExpiry();
    error SessionNotFound(uint256 sessionId);
    error SessionInactive(uint256 sessionId);
    error SessionIsPaused(uint256 sessionId);
    error SessionExpired(uint256 sessionId, uint64 validUntil);
    error PerTxLimitExceeded(uint256 amount, uint256 limit);
    error DailyLimitExceeded(uint256 projectedDailySpend, uint256 dailyLimit);
    error BudgetExceeded(uint256 remainingBudget, uint256 requested);
    error RecipientNotAllowed(uint256 sessionId, address recipient);
    error InvalidNonce(uint256 expected, uint256 provided);
    error SignatureExpired(uint64 deadline);
    error InvalidSignature();
    error InvoiceNotFound(uint256 invoiceId);
    error InvoiceNotPending(uint256 invoiceId);
    error InvoiceExpired(uint256 invoiceId, uint64 expiresAt);
    error InvoiceNotYetExpired(uint256 invoiceId, uint64 expiresAt);
    error InvalidConfirmationHash();
    error InvalidConfirmationCode();
    error SafeTransferFailed();
    error DepositMismatch(uint256 expected, uint256 received);

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ContractPauseUpdated(bool paused);
    event TreasuryDeposited(address indexed payer, uint256 amount, uint256 newBalance);
    event TreasuryWithdrawn(address indexed payer, address indexed to, uint256 amount, uint256 newBalance);
    event SessionCreated(
        uint256 indexed sessionId,
        address indexed payer,
        address indexed agent,
        uint128 perTxLimit,
        uint128 dailyLimit,
        uint128 totalBudget,
        uint64 validUntil,
        bool enforceAllowlist,
        string label
    );
    event SessionToppedUp(uint256 indexed sessionId, address indexed payer, uint128 addedBudget, uint128 newTotalBudget);
    event SessionAllowlistUpdated(uint256 indexed sessionId, address indexed recipient, bool allowed);
    event SessionPauseUpdated(uint256 indexed sessionId, bool paused);
    event SessionRevoked(uint256 indexed sessionId, address indexed payer, uint256 refundedAmount);
    event AgentPaymentExecuted(
        uint256 indexed sessionId,
        address indexed payer,
        address indexed agent,
        address recipient,
        uint256 amount,
        uint256 nonce,
        bytes32 memoHash,
        bool viaSignature
    );
    event InvoiceCreated(
        uint256 indexed invoiceId,
        uint256 indexed sessionId,
        address indexed payer,
        address payee,
        uint256 amount,
        uint64 expiresAt,
        bytes32 confirmationHash,
        string invoiceURI
    );
    event InvoiceConfirmedAndPaid(
        uint256 indexed invoiceId,
        address indexed payer,
        address indexed payee,
        uint256 sessionId,
        uint256 amount,
        bytes32 confirmationHash
    );
    event InvoiceRefunded(
        uint256 indexed invoiceId,
        address indexed payer,
        address indexed payee,
        uint256 amount,
        bool expiredReclaim
    );

    // -------------------------------------------------------------------------
    // Modifiers
    // -------------------------------------------------------------------------

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert ContractPaused();
        _;
    }

    modifier nonReentrant() {
        if (_lockStatus == _ENTERED) revert ReentrancyDetected();
        _lockStatus = _ENTERED;
        _;
        _lockStatus = _NOT_ENTERED;
    }

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    constructor(address tokenAddress) {
        if (tokenAddress == address(0)) revert ZeroAddress();
        if (tokenAddress.code.length == 0) revert InvalidTokenContract();

        token = IERC20Minimal(tokenAddress);
        owner = msg.sender;
        _lockStatus = _NOT_ENTERED;
        nextSessionId = 1;
        nextInvoiceId = 1;

        _initialChainId = block.chainid;
        _initialDomainSeparator = _computeDomainSeparator();

        emit OwnershipTransferred(address(0), msg.sender);
    }

    // -------------------------------------------------------------------------
    // Admin Controls
    // -------------------------------------------------------------------------

    function pause() external onlyOwner {
        paused = true;
        emit ContractPauseUpdated(true);
    }

    function unpause() external onlyOwner {
        paused = false;
        emit ContractPauseUpdated(false);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        address prev = owner;
        owner = newOwner;
        emit OwnershipTransferred(prev, newOwner);
    }

    // -------------------------------------------------------------------------
    // Treasury Deposit & Withdraw
    // -------------------------------------------------------------------------

    function deposit(uint256 amount) external nonReentrant whenNotPaused returns (uint256 received) {
        if (amount == 0) revert ZeroAmount();

        uint256 beforeBal = token.balanceOf(address(this));
        _safeTransferFrom(msg.sender, address(this), amount);
        uint256 afterBal = token.balanceOf(address(this));

        received = afterBal - beforeBal;
        if (received == 0) revert ZeroAmount();

        availableBalance[msg.sender] += received;
        totalAvailableLiquidity += received;

        emit TreasuryDeposited(msg.sender, received, availableBalance[msg.sender]);
    }

    /// @notice Withdraws unencumbered payer balance (allowed even if contract is paused for user safety).
    function withdraw(uint256 amount, address to) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (to == address(0)) revert ZeroAddress();

        uint256 bal = availableBalance[msg.sender];
        if (bal < amount) revert InsufficientTreasuryBalance(bal, amount);

        uint256 newBal = bal - amount;
        availableBalance[msg.sender] = newBal;
        totalAvailableLiquidity -= amount;

        _safeTransfer(to, amount);

        emit TreasuryWithdrawn(msg.sender, to, amount, newBal);
    }

    // -------------------------------------------------------------------------
    // AI Agent Session Management
    // -------------------------------------------------------------------------

    function createSession(
        address agent,
        uint128 perTxLimit,
        uint128 dailyLimit,
        uint128 totalBudget,
        uint64 validUntil,
        bool enforceAllowlist,
        address[] calldata initialAllowlist,
        string calldata label
    ) external nonReentrant whenNotPaused returns (uint256 sessionId) {
        uint256 bal = availableBalance[msg.sender];
        if (bal < totalBudget) revert InsufficientTreasuryBalance(bal, totalBudget);

        availableBalance[msg.sender] = bal - totalBudget;
        totalAvailableLiquidity -= totalBudget;
        totalSessionUnspent += totalBudget;

        sessionId = _createSessionInternal(
            msg.sender,
            agent,
            perTxLimit,
            dailyLimit,
            totalBudget,
            validUntil,
            enforceAllowlist,
            initialAllowlist,
            label
        );
    }

    /// @notice Atomic one-transaction flow: pulls tUSD8 from payer and funds a scoped AI agent session.
    function createSessionWithDeposit(
        address agent,
        uint128 perTxLimit,
        uint128 dailyLimit,
        uint128 totalBudget,
        uint64 validUntil,
        bool enforceAllowlist,
        address[] calldata initialAllowlist,
        string calldata label
    ) external nonReentrant whenNotPaused returns (uint256 sessionId) {
        if (totalBudget == 0) revert InvalidPolicyLimits();

        uint256 beforeBal = token.balanceOf(address(this));
        _safeTransferFrom(msg.sender, address(this), totalBudget);
        uint256 received = token.balanceOf(address(this)) - beforeBal;
        if (received != totalBudget) revert DepositMismatch(totalBudget, received);

        totalSessionUnspent += totalBudget;

        sessionId = _createSessionInternal(
            msg.sender,
            agent,
            perTxLimit,
            dailyLimit,
            totalBudget,
            validUntil,
            enforceAllowlist,
            initialAllowlist,
            label
        );
    }

    function topUpSession(uint256 sessionId, uint128 addedBudget) external nonReentrant whenNotPaused {
        if (addedBudget == 0) revert ZeroAmount();

        AgentSession storage s = _sessions[sessionId];
        if (s.payer == address(0)) revert SessionNotFound(sessionId);
        if (s.payer != msg.sender) revert Unauthorized();
        if (!s.active) revert SessionInactive(sessionId);

        uint256 bal = availableBalance[msg.sender];
        if (bal < addedBudget) revert InsufficientTreasuryBalance(bal, addedBudget);

        uint256 newBudget = uint256(s.totalBudget) + uint256(addedBudget);
        if (newBudget > type(uint128).max) revert AmountOverflow();

        availableBalance[msg.sender] = bal - addedBudget;
        totalAvailableLiquidity -= addedBudget;
        totalSessionUnspent += addedBudget;
        s.totalBudget = uint128(newBudget);

        emit SessionToppedUp(sessionId, msg.sender, addedBudget, s.totalBudget);
    }

    function setSessionAllowlist(
        uint256 sessionId,
        address[] calldata recipients,
        bool allowed
    ) external whenNotPaused {
        AgentSession storage s = _sessions[sessionId];
        if (s.payer == address(0)) revert SessionNotFound(sessionId);
        if (s.payer != msg.sender) revert Unauthorized();
        if (!s.active) revert SessionInactive(sessionId);

        uint256 len = recipients.length;
        for (uint256 i = 0; i < len; ) {
            address r = recipients[i];
            if (r == address(0)) revert ZeroAddress();
            sessionAllowlist[sessionId][r] = allowed;
            emit SessionAllowlistUpdated(sessionId, r, allowed);
            unchecked {
                ++i;
            }
        }
    }

    function setSessionPaused(uint256 sessionId, bool isPaused) external {
        AgentSession storage s = _sessions[sessionId];
        if (s.payer == address(0)) revert SessionNotFound(sessionId);
        if (s.payer != msg.sender) revert Unauthorized();
        if (!s.active) revert SessionInactive(sessionId);

        s.paused = isPaused;
        emit SessionPauseUpdated(sessionId, isPaused);
    }

    /// @notice Immediately revokes an agent session and returns unspent budget to payer's availableBalance.
    ///         Always callable by the payer even if the contract is globally paused.
    function revokeSession(uint256 sessionId) external nonReentrant returns (uint256 refundedAmount) {
        refundedAmount = _revokeSessionInternal(sessionId);
        availableBalance[msg.sender] += refundedAmount;
        totalAvailableLiquidity += refundedAmount;
    }

    /// @notice Immediately revokes an agent session and transfers unspent tUSD8 directly to payer's wallet.
    function revokeSessionAndWithdraw(uint256 sessionId) external nonReentrant returns (uint256 refundedAmount) {
        refundedAmount = _revokeSessionInternal(sessionId);
        if (refundedAmount > 0) {
            _safeTransfer(msg.sender, refundedAmount);
        }
    }

    // -------------------------------------------------------------------------
    // Scoped AI Agent Direct & EIP-712 Delegated Payment Execution
    // -------------------------------------------------------------------------

    function executeAgentPayment(
        uint256 sessionId,
        address recipient,
        uint256 amount,
        uint256 nonce,
        bytes32 memoHash
    ) external nonReentrant whenNotPaused {
        AgentSession storage s = _sessions[sessionId];
        if (s.payer == address(0)) revert SessionNotFound(sessionId);
        if (msg.sender != s.agent) revert Unauthorized();

        _consumeSessionPolicy(s, sessionId, recipient, amount, nonce);
        totalSessionUnspent -= amount;

        _safeTransfer(recipient, amount);

        emit AgentPaymentExecuted(sessionId, s.payer, s.agent, recipient, amount, nonce, memoHash, false);
    }

    function executeAgentPaymentWithSig(
        uint256 sessionId,
        address recipient,
        uint256 amount,
        uint256 nonce,
        uint64 deadline,
        bytes32 memoHash,
        bytes calldata signature
    ) external nonReentrant whenNotPaused {
        if (block.timestamp > deadline) revert SignatureExpired(deadline);

        AgentSession storage s = _sessions[sessionId];
        if (s.payer == address(0)) revert SessionNotFound(sessionId);

        bytes32 structHash = keccak256(
            abi.encode(AGENT_PAYMENT_TYPEHASH, sessionId, recipient, amount, nonce, deadline, memoHash)
        );
        bytes32 digest = _hashTypedDataV4(structHash);
        address recovered = _recoverSigner(digest, signature);
        if (recovered != s.agent) revert InvalidSignature();

        _consumeSessionPolicy(s, sessionId, recipient, amount, nonce);
        totalSessionUnspent -= amount;

        _safeTransfer(recipient, amount);

        emit AgentPaymentExecuted(sessionId, s.payer, s.agent, recipient, amount, nonce, memoHash, true);
    }

    // -------------------------------------------------------------------------
    // Confirmation-of-Payee (CoP) Invoice & Payroll Escrow
    // -------------------------------------------------------------------------

    function createInvoiceByPayer(
        address payee,
        uint256 amount,
        uint64 expiresAt,
        bytes32 confirmationHash,
        string calldata invoiceURI
    ) external nonReentrant whenNotPaused returns (uint256 invoiceId) {
        _validateInvoiceParams(payee, amount, expiresAt, confirmationHash);

        uint256 bal = availableBalance[msg.sender];
        if (bal < amount) revert InsufficientTreasuryBalance(bal, amount);

        availableBalance[msg.sender] = bal - amount;
        totalAvailableLiquidity -= amount;
        totalEscrowedInvoices += amount;

        invoiceId = _storeInvoice(msg.sender, payee, 0, uint128(amount), expiresAt, confirmationHash, invoiceURI);
    }

    function createInvoiceByAgent(
        uint256 sessionId,
        address payee,
        uint256 amount,
        uint64 expiresAt,
        bytes32 confirmationHash,
        string calldata invoiceURI,
        uint256 nonce
    ) external nonReentrant whenNotPaused returns (uint256 invoiceId) {
        _validateInvoiceParams(payee, amount, expiresAt, confirmationHash);

        AgentSession storage s = _sessions[sessionId];
        if (s.payer == address(0)) revert SessionNotFound(sessionId);
        if (msg.sender != s.agent) revert Unauthorized();

        _consumeSessionPolicy(s, sessionId, payee, amount, nonce);
        totalSessionUnspent -= amount;
        totalEscrowedInvoices += amount;

        invoiceId = _storeInvoice(s.payer, payee, sessionId, uint128(amount), expiresAt, confirmationHash, invoiceURI);
    }

    function createInvoiceByAgentWithSig(
        uint256 sessionId,
        address payee,
        uint256 amount,
        uint64 expiresAt,
        bytes32 confirmationHash,
        string calldata invoiceURI,
        uint256 nonce,
        uint64 deadline,
        bytes calldata signature
    ) external nonReentrant whenNotPaused returns (uint256 invoiceId) {
        if (block.timestamp > deadline) revert SignatureExpired(deadline);
        _validateInvoiceParams(payee, amount, expiresAt, confirmationHash);

        AgentSession storage s = _sessions[sessionId];
        if (s.payer == address(0)) revert SessionNotFound(sessionId);

        _verifyAgentInvoiceSignature(
            s.agent,
            sessionId,
            payee,
            amount,
            expiresAt,
            confirmationHash,
            nonce,
            deadline,
            signature
        );

        _consumeSessionPolicy(s, sessionId, payee, amount, nonce);
        totalSessionUnspent -= amount;
        totalEscrowedInvoices += amount;

        invoiceId = _storeInvoice(s.payer, payee, sessionId, uint128(amount), expiresAt, confirmationHash, invoiceURI);
    }

    /// @notice Payee confirms identity + invoice reference code (Confirmation of Payee) to settle escrow.
    function confirmAndClaimInvoice(
        uint256 invoiceId,
        string calldata confirmationCode
    ) external nonReentrant whenNotPaused {
        Invoice storage inv = _invoices[invoiceId];
        if (inv.status == InvoiceStatus.None) revert InvoiceNotFound(invoiceId);
        if (inv.status != InvoiceStatus.Pending) revert InvoiceNotPending(invoiceId);
        if (msg.sender != inv.payee) revert Unauthorized();
        if (block.timestamp > inv.expiresAt) revert InvoiceExpired(invoiceId, inv.expiresAt);

        bytes32 computed = keccak256(abi.encode(msg.sender, confirmationCode));
        if (computed != inv.confirmationHash) revert InvalidConfirmationCode();

        // CEI: update state before external token transfer
        uint256 payout = inv.amount;
        inv.status = InvoiceStatus.Claimed;
        inv.settledAt = uint64(block.timestamp);
        totalEscrowedInvoices -= payout;

        _safeTransfer(inv.payee, payout);

        emit InvoiceConfirmedAndPaid(invoiceId, inv.payer, inv.payee, inv.sessionId, payout, inv.confirmationHash);
    }

    /// @notice Allows payer to safely reclaim escrowed tUSD8 if the payee never confirmed before expiry.
    ///         Always callable even while contract is paused so funds can never be trapped.
    function reclaimExpiredInvoice(uint256 invoiceId) external nonReentrant {
        Invoice storage inv = _invoices[invoiceId];
        if (inv.status == InvoiceStatus.None) revert InvoiceNotFound(invoiceId);
        if (inv.status != InvoiceStatus.Pending) revert InvoiceNotPending(invoiceId);
        if (msg.sender != inv.payer) revert Unauthorized();
        if (block.timestamp <= inv.expiresAt) revert InvoiceNotYetExpired(invoiceId, inv.expiresAt);

        uint256 refundAmount = inv.amount;
        inv.status = InvoiceStatus.Refunded;
        inv.settledAt = uint64(block.timestamp);
        totalEscrowedInvoices -= refundAmount;
        availableBalance[inv.payer] += refundAmount;
        totalAvailableLiquidity += refundAmount;

        emit InvoiceRefunded(invoiceId, inv.payer, inv.payee, refundAmount, true);
    }

    /// @notice Allows the intended payee to decline an erroneous invoice and immediately return escrow to payer.
    function rejectInvoice(uint256 invoiceId) external nonReentrant {
        Invoice storage inv = _invoices[invoiceId];
        if (inv.status == InvoiceStatus.None) revert InvoiceNotFound(invoiceId);
        if (inv.status != InvoiceStatus.Pending) revert InvoiceNotPending(invoiceId);
        if (msg.sender != inv.payee) revert Unauthorized();

        uint256 refundAmount = inv.amount;
        inv.status = InvoiceStatus.Refunded;
        inv.settledAt = uint64(block.timestamp);
        totalEscrowedInvoices -= refundAmount;
        availableBalance[inv.payer] += refundAmount;
        totalAvailableLiquidity += refundAmount;

        emit InvoiceRefunded(invoiceId, inv.payer, inv.payee, refundAmount, false);
    }

    // -------------------------------------------------------------------------
    // Read / View Helpers
    // -------------------------------------------------------------------------

    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return block.chainid == _initialChainId ? _initialDomainSeparator : _computeDomainSeparator();
    }

    function computeConfirmationHash(
        address payee,
        string calldata confirmationCode
    ) external pure returns (bytes32) {
        return keccak256(abi.encode(payee, confirmationCode));
    }

    function getSession(uint256 sessionId) external view returns (AgentSession memory) {
        return _sessions[sessionId];
    }

    function getInvoice(uint256 invoiceId) external view returns (Invoice memory) {
        return _invoices[invoiceId];
    }

    function getRolling24hSpent(uint256 sessionId) public view returns (uint256 total) {
        uint256 currentHour = block.timestamp / HOUR_SECONDS;
        uint256 startHour = currentHour >= (ROLLING_WINDOW_HOURS - 1)
            ? currentHour - (ROLLING_WINDOW_HOURS - 1)
            : 0;

        for (uint256 h = startHour; h <= currentHour; ) {
            total += _hourlySpend[sessionId][h];
            unchecked {
                ++h;
            }
        }
    }

    function getSessionRemainingAllowance(uint256 sessionId)
        external
        view
        returns (uint256 remainingTotal, uint256 remainingDaily, uint256 maxNextTx)
    {
        AgentSession storage s = _sessions[sessionId];
        if (!s.active || s.paused || block.timestamp > s.validUntil) {
            return (0, 0, 0);
        }

        remainingTotal = uint256(s.totalBudget) - uint256(s.spentTotal);
        uint256 rollingSpent = getRolling24hSpent(sessionId);
        remainingDaily = rollingSpent >= s.dailyLimit ? 0 : uint256(s.dailyLimit) - rollingSpent;

        uint256 bounded = remainingTotal < remainingDaily ? remainingTotal : remainingDaily;
        maxNextTx = bounded < s.perTxLimit ? bounded : s.perTxLimit;
    }

    function totalTrackedLiabilities() external view returns (uint256) {
        return totalAvailableLiquidity + totalSessionUnspent + totalEscrowedInvoices;
    }

    // -------------------------------------------------------------------------
    // Internal Logic
    // -------------------------------------------------------------------------

    function _createSessionInternal(
        address payer,
        address agent,
        uint128 perTxLimit,
        uint128 dailyLimit,
        uint128 totalBudget,
        uint64 validUntil,
        bool enforceAllowlist,
        address[] calldata initialAllowlist,
        string calldata label
    ) internal returns (uint256 sessionId) {
        if (agent == address(0)) revert ZeroAddress();
        if (perTxLimit == 0 || dailyLimit == 0 || totalBudget == 0) revert InvalidPolicyLimits();
        if (perTxLimit > dailyLimit || perTxLimit > totalBudget) revert InvalidPolicyLimits();
        if (validUntil <= block.timestamp) revert InvalidExpiry();

        sessionId = nextSessionId++;
        _sessions[sessionId] = AgentSession({
            payer: payer,
            agent: agent,
            perTxLimit: perTxLimit,
            dailyLimit: dailyLimit,
            totalBudget: totalBudget,
            spentTotal: 0,
            validUntil: validUntil,
            enforceAllowlist: enforceAllowlist,
            active: true,
            paused: false,
            label: label
        });

        uint256 len = initialAllowlist.length;
        for (uint256 i = 0; i < len; ) {
            address r = initialAllowlist[i];
            if (r == address(0)) revert ZeroAddress();
            sessionAllowlist[sessionId][r] = true;
            emit SessionAllowlistUpdated(sessionId, r, true);
            unchecked {
                ++i;
            }
        }

        emit SessionCreated(
            sessionId,
            payer,
            agent,
            perTxLimit,
            dailyLimit,
            totalBudget,
            validUntil,
            enforceAllowlist,
            label
        );
    }

    function _revokeSessionInternal(uint256 sessionId) internal returns (uint256 refundedAmount) {
        AgentSession storage s = _sessions[sessionId];
        if (s.payer == address(0)) revert SessionNotFound(sessionId);
        if (s.payer != msg.sender) revert Unauthorized();
        if (!s.active) revert SessionInactive(sessionId);

        refundedAmount = uint256(s.totalBudget) - uint256(s.spentTotal);
        s.active = false;
        s.totalBudget = s.spentTotal;
        totalSessionUnspent -= refundedAmount;

        emit SessionRevoked(sessionId, msg.sender, refundedAmount);
    }

    function _consumeSessionPolicy(
        AgentSession storage s,
        uint256 sessionId,
        address recipient,
        uint256 amount,
        uint256 nonce
    ) internal {
        if (recipient == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (!s.active) revert SessionInactive(sessionId);
        if (s.paused) revert SessionIsPaused(sessionId);
        if (block.timestamp > s.validUntil) revert SessionExpired(sessionId, s.validUntil);
        if (s.enforceAllowlist && !sessionAllowlist[sessionId][recipient]) {
            revert RecipientNotAllowed(sessionId, recipient);
        }

        uint256 expectedNonce = sessionNonces[sessionId];
        if (nonce != expectedNonce) revert InvalidNonce(expectedNonce, nonce);

        if (amount > s.perTxLimit) revert PerTxLimitExceeded(amount, s.perTxLimit);

        uint256 remainingBudget = uint256(s.totalBudget) - uint256(s.spentTotal);
        if (amount > remainingBudget) revert BudgetExceeded(remainingBudget, amount);

        uint256 rollingSpent = getRolling24hSpent(sessionId);
        uint256 projectedDaily = rollingSpent + amount;
        if (projectedDaily > s.dailyLimit) revert DailyLimitExceeded(projectedDaily, s.dailyLimit);

        // State effects (CEI)
        sessionNonces[sessionId] = expectedNonce + 1;
        s.spentTotal = uint128(uint256(s.spentTotal) + amount);

        uint256 currentHour = block.timestamp / HOUR_SECONDS;
        _hourlySpend[sessionId][currentHour] = uint128(uint256(_hourlySpend[sessionId][currentHour]) + amount);
    }

    function _validateInvoiceParams(
        address payee,
        uint256 amount,
        uint64 expiresAt,
        bytes32 confirmationHash
    ) internal view {
        if (payee == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (amount > type(uint128).max) revert AmountOverflow();
        if (expiresAt <= block.timestamp) revert InvalidExpiry();
        if (confirmationHash == bytes32(0)) revert InvalidConfirmationHash();
    }

    function _storeInvoice(
        address payer,
        address payee,
        uint256 sessionId,
        uint128 amount,
        uint64 expiresAt,
        bytes32 confirmationHash,
        string calldata invoiceURI
    ) internal returns (uint256 invoiceId) {
        invoiceId = nextInvoiceId++;
        _invoices[invoiceId] = Invoice({
            payer: payer,
            payee: payee,
            sessionId: sessionId,
            amount: amount,
            createdAt: uint64(block.timestamp),
            expiresAt: expiresAt,
            settledAt: 0,
            status: InvoiceStatus.Pending,
            confirmationHash: confirmationHash,
            invoiceURI: invoiceURI
        });

        emit InvoiceCreated(invoiceId, sessionId, payer, payee, amount, expiresAt, confirmationHash, invoiceURI);
    }

    function _verifyAgentInvoiceSignature(
        address expectedAgent,
        uint256 sessionId,
        address payee,
        uint256 amount,
        uint64 expiresAt,
        bytes32 confirmationHash,
        uint256 nonce,
        uint64 deadline,
        bytes calldata signature
    ) internal view {
        bytes32 structHash = keccak256(
            abi.encode(AGENT_INVOICE_TYPEHASH, sessionId, payee, amount, expiresAt, confirmationHash, nonce, deadline)
        );
        address recovered = _recoverSigner(_hashTypedDataV4(structHash), signature);
        if (recovered != expectedAgent) revert InvalidSignature();
    }

    function _computeDomainSeparator() internal view returns (bytes32) {
        return keccak256(
            abi.encode(EIP712_DOMAIN_TYPEHASH, _NAME_HASH, _VERSION_HASH, block.chainid, address(this))
        );
    }

    function _hashTypedDataV4(bytes32 structHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), structHash));
    }

    function _recoverSigner(bytes32 digest, bytes calldata signature) internal pure returns (address) {
        if (signature.length != 65) revert InvalidSignature();

        bytes32 r;
        bytes32 s;
        uint8 v;

        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }

        if (v < 27) {
            v += 27;
        }
        if (v != 27 && v != 28) revert InvalidSignature();
        if (uint256(s) > _SECP256K1N_HALF) revert InvalidSignature();

        address signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert InvalidSignature();
        return signer;
    }

    function _safeTransfer(address to, uint256 value) internal {
        (bool success, bytes memory data) = address(token).call(
            abi.encodeWithSelector(IERC20Minimal.transfer.selector, to, value)
        );
        if (!success || (data.length != 0 && !abi.decode(data, (bool)))) {
            revert SafeTransferFailed();
        }
    }

    function _safeTransferFrom(address from, address to, uint256 value) internal {
        (bool success, bytes memory data) = address(token).call(
            abi.encodeWithSelector(IERC20Minimal.transferFrom.selector, from, to, value)
        );
        if (!success || (data.length != 0 && !abi.decode(data, (bool)))) {
            revert SafeTransferFailed();
        }
    }
}
