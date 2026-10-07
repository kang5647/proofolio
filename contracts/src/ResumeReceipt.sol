// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {ReceiverTemplate} from "./ReceiverTemplate.sol";

/**
 * @title ResumeReceipt
 * @notice CRE consumer for ProofDesk. Buyers (or the verifier on their behalf) commit an
 *         immutable, scoped, nonce-bound, expiring verification request. The CRE workflow
 *         reads that scope, computes the scoped result confidentially, and delivers a report
 *         through the Chainlink Forwarder that binds the request to a certificate digest.
 *
 *         Security model:
 *           - onReport is only accepted from the configured forwarder (ReceiverTemplate),
 *             and optionally from one workflow owner / name / id.
 *           - A report must reference an existing request, carry the request's nonce and
 *             account commitment, match its expiry, arrive before expiry, and may be
 *             accepted only once (replay rejected).
 *         There is intentionally no bare "store a hash" method.
 */
contract ResumeReceipt is ReceiverTemplate {
    struct Request {
        address buyer;
        bytes32 accountCommitment;
        bytes32 runIdHash; // keccak256(bytes(runId))
        bytes32 marketHash; // keccak256(bytes(market))
        uint64 intervalStart; // unix seconds, inclusive
        uint64 intervalEnd; // unix seconds, exclusive
        bytes32 methodologyHash; // keccak256(bytes(methodologyVersion))
        bytes32 nonce;
        uint64 expiresAt; // unix seconds
        uint64 committedAt;
    }

    struct Receipt {
        bytes32 certDigest;
        uint8 status; // 1 = VERIFIED, 2 = UNVERIFIABLE
        uint64 recordedAt;
        bool exists;
    }

    mapping(bytes32 => Request) private s_requests;
    mapping(bytes32 => Receipt) private s_receipts;

    event RequestCommitted(bytes32 indexed requestId, address indexed buyer, bytes32 indexed accountCommitment, uint64 expiresAt);
    event ReceiptRecorded(bytes32 indexed requestId, bytes32 certDigest, uint8 status);

    error RequestExists(bytes32 requestId);
    error RequestIdMismatch(bytes32 given, bytes32 computed);
    error UnknownRequest(bytes32 requestId);
    error ReceiptExists(bytes32 requestId);
    error RequestExpired(bytes32 requestId, uint64 expiresAt);
    error NonceMismatch(bytes32 requestId);
    error CommitmentMismatch(bytes32 requestId);
    error ExpiryMismatch(bytes32 requestId);
    error InvalidStatus(uint8 status);
    error InvalidInterval();
    error InvalidExpiry();

    constructor(address forwarder) ReceiverTemplate(forwarder) {}

    /// @notice Deterministic request id. Both the off-chain client and the workflow recompute it.
    function computeRequestId(
        address buyer,
        bytes32 accountCommitment,
        bytes32 runIdHash,
        bytes32 marketHash,
        uint64 intervalStart,
        uint64 intervalEnd,
        bytes32 methodologyHash,
        bytes32 nonce,
        uint64 expiresAt
    ) public pure returns (bytes32) {
        return keccak256(
            abi.encode(
                "proofdesk-request/1",
                buyer,
                accountCommitment,
                runIdHash,
                marketHash,
                intervalStart,
                intervalEnd,
                methodologyHash,
                nonce,
                expiresAt
            )
        );
    }

    /// @notice Commit an immutable verification request. Anyone may commit; the buyer field
    ///         names the party the certificate is issued to.
    function commitRequest(
        bytes32 requestId,
        address buyer,
        bytes32 accountCommitment,
        bytes32 runIdHash,
        bytes32 marketHash,
        uint64 intervalStart,
        uint64 intervalEnd,
        bytes32 methodologyHash,
        bytes32 nonce,
        uint64 expiresAt
    ) external {
        if (intervalEnd <= intervalStart) revert InvalidInterval();
        if (expiresAt <= block.timestamp) revert InvalidExpiry();
        bytes32 computed = computeRequestId(
            buyer, accountCommitment, runIdHash, marketHash, intervalStart, intervalEnd, methodologyHash, nonce, expiresAt
        );
        if (computed != requestId) revert RequestIdMismatch(requestId, computed);
        if (s_requests[requestId].committedAt != 0) revert RequestExists(requestId);
        s_requests[requestId] = Request({
            buyer: buyer,
            accountCommitment: accountCommitment,
            runIdHash: runIdHash,
            marketHash: marketHash,
            intervalStart: intervalStart,
            intervalEnd: intervalEnd,
            methodologyHash: methodologyHash,
            nonce: nonce,
            expiresAt: expiresAt,
            committedAt: uint64(block.timestamp)
        });
        emit RequestCommitted(requestId, buyer, accountCommitment, expiresAt);
    }

    /// @dev Report payload: abi.encode(bytes32 requestId, bytes32 certDigest, uint8 status,
    ///      uint64 expiresAt, bytes32 accountCommitment, bytes32 nonce)
    function _processReport(bytes calldata report) internal override {
        (bytes32 requestId, bytes32 certDigest, uint8 status, uint64 expiresAt, bytes32 accountCommitment, bytes32 nonce) =
            abi.decode(report, (bytes32, bytes32, uint8, uint64, bytes32, bytes32));
        Request storage req = s_requests[requestId];
        if (req.committedAt == 0) revert UnknownRequest(requestId);
        if (s_receipts[requestId].exists) revert ReceiptExists(requestId);
        if (block.timestamp >= req.expiresAt) revert RequestExpired(requestId, req.expiresAt);
        if (req.nonce != nonce) revert NonceMismatch(requestId);
        if (req.accountCommitment != accountCommitment) revert CommitmentMismatch(requestId);
        if (req.expiresAt != expiresAt) revert ExpiryMismatch(requestId);
        if (status != 1 && status != 2) revert InvalidStatus(status);
        s_receipts[requestId] = Receipt({certDigest: certDigest, status: status, recordedAt: uint64(block.timestamp), exists: true});
        emit ReceiptRecorded(requestId, certDigest, status);
    }

    function getRequest(bytes32 requestId) external view returns (Request memory) {
        return s_requests[requestId];
    }

    function getReceipt(bytes32 requestId) external view returns (Receipt memory) {
        return s_receipts[requestId];
    }

    /// @notice Buyer-side check: does an accepted receipt bind this request to this digest, and is it unexpired?
    function verifyReceipt(bytes32 requestId, bytes32 certDigest) external view returns (bool ok, string memory reason) {
        Request storage req = s_requests[requestId];
        if (req.committedAt == 0) return (false, "unknown request");
        Receipt storage r = s_receipts[requestId];
        if (!r.exists) return (false, "no receipt recorded");
        if (r.certDigest != certDigest) return (false, "certificate digest mismatch");
        if (block.timestamp >= req.expiresAt) return (false, "request expired");
        return (true, "");
    }
}
