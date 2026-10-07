// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {Test} from "forge-std/Test.sol";
import {ResumeReceipt} from "../src/ResumeReceipt.sol";
import {MockForwarder} from "../src/MockForwarder.sol";
import {ReceiverTemplate} from "../src/ReceiverTemplate.sol";

contract ResumeReceiptTest is Test {
    ResumeReceipt rr;
    MockForwarder fwd;
    address operator = address(0xA11CE);
    address buyer = address(0xB0B);
    bytes32 commitment = keccak256("acct");
    bytes32 runHash = keccak256("run-1");
    bytes32 mktHash = keccak256("SIM-SOL/USDT");
    bytes32 methHash = keccak256("proofdesk-accounting/1.0.0");
    bytes32 nonce = keccak256("nonce");
    uint64 start = 1_000;
    uint64 end_ = 2_000;
    uint64 expiry;
    bytes32 reqId;
    bytes meta = abi.encodePacked(bytes32(uint256(1)), bytes10(0), address(this));

    function setUp() public {
        vm.warp(10_000);
        expiry = uint64(block.timestamp + 1 days);
        fwd = new MockForwarder(operator);
        rr = new ResumeReceipt(address(fwd));
        reqId = rr.computeRequestId(buyer, commitment, runHash, mktHash, start, end_, methHash, nonce, expiry);
        rr.commitRequest(reqId, buyer, commitment, runHash, mktHash, start, end_, methHash, nonce, expiry);
    }

    function _report(bytes32 id, bytes32 digest, uint8 status, uint64 exp, bytes32 c, bytes32 n) internal pure returns (bytes memory) {
        return abi.encode(id, digest, status, exp, c, n);
    }

    function test_commit_is_immutable_and_id_bound() public {
        vm.expectRevert(abi.encodeWithSelector(ResumeReceipt.RequestExists.selector, reqId));
        rr.commitRequest(reqId, buyer, commitment, runHash, mktHash, start, end_, methHash, nonce, expiry);
        bytes32 wrong = keccak256("x");
        vm.expectRevert();
        rr.commitRequest(wrong, buyer, commitment, runHash, mktHash, start, end_, methHash, nonce, expiry);
    }

    function test_receipt_via_forwarder_and_buyer_verify() public {
        bytes32 digest = keccak256("cert");
        vm.prank(operator);
        fwd.forward(address(rr), meta, _report(reqId, digest, 1, expiry, commitment, nonce));
        (bool ok, string memory reason) = rr.verifyReceipt(reqId, digest);
        assertTrue(ok, reason);
        (bool ok2, string memory reason2) = rr.verifyReceipt(reqId, keccak256("tampered"));
        assertFalse(ok2);
        assertEq(reason2, "certificate digest mismatch");
    }

    function test_rejects_direct_onReport_not_from_forwarder() public {
        vm.expectRevert(abi.encodeWithSelector(ReceiverTemplate.InvalidSender.selector, address(this), address(fwd)));
        rr.onReport(meta, _report(reqId, keccak256("c"), 1, expiry, commitment, nonce));
    }

    function test_rejects_replay() public {
        vm.startPrank(operator);
        fwd.forward(address(rr), meta, _report(reqId, keccak256("c"), 2, expiry, commitment, nonce));
        vm.expectRevert(abi.encodeWithSelector(ResumeReceipt.ReceiptExists.selector, reqId));
        fwd.forward(address(rr), meta, _report(reqId, keccak256("c"), 2, expiry, commitment, nonce));
        vm.stopPrank();
    }

    function test_rejects_mismatched_request_nonce_commitment_expiry() public {
        vm.startPrank(operator);
        vm.expectRevert(abi.encodeWithSelector(ResumeReceipt.UnknownRequest.selector, keccak256("other")));
        fwd.forward(address(rr), meta, _report(keccak256("other"), keccak256("c"), 1, expiry, commitment, nonce));
        vm.expectRevert(abi.encodeWithSelector(ResumeReceipt.NonceMismatch.selector, reqId));
        fwd.forward(address(rr), meta, _report(reqId, keccak256("c"), 1, expiry, commitment, keccak256("bad")));
        vm.expectRevert(abi.encodeWithSelector(ResumeReceipt.CommitmentMismatch.selector, reqId));
        fwd.forward(address(rr), meta, _report(reqId, keccak256("c"), 1, expiry, keccak256("bad"), nonce));
        vm.expectRevert(abi.encodeWithSelector(ResumeReceipt.ExpiryMismatch.selector, reqId));
        fwd.forward(address(rr), meta, _report(reqId, keccak256("c"), 1, expiry + 1, commitment, nonce));
        vm.expectRevert(abi.encodeWithSelector(ResumeReceipt.InvalidStatus.selector, uint8(7)));
        fwd.forward(address(rr), meta, _report(reqId, keccak256("c"), 7, expiry, commitment, nonce));
        vm.stopPrank();
    }

    function test_rejects_expired_report_and_expired_verify() public {
        vm.warp(expiry);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(ResumeReceipt.RequestExpired.selector, reqId, expiry));
        fwd.forward(address(rr), meta, _report(reqId, keccak256("c"), 1, expiry, commitment, nonce));
    }

    function test_workflow_identity_check() public {
        rr.setExpectedAuthor(address(0xDEAD));
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(ReceiverTemplate.InvalidAuthor.selector, address(this), address(0xDEAD)));
        fwd.forward(address(rr), meta, _report(reqId, keccak256("c"), 1, expiry, commitment, nonce));
    }
}
