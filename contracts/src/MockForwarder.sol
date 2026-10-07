// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {IReceiver} from "./IReceiver.sol";

/**
 * @title MockForwarder
 * @notice LOCAL SIMULATION ONLY. Stands in for the Chainlink KeystoneForwarder on a local
 *         anvil chain so the receiver's forwarder check can be exercised end to end. It
 *         performs no signature verification. Never deploy to a public network.
 */
contract MockForwarder {
    address public immutable operator;

    error NotOperator();

    constructor(address _operator) {
        operator = _operator;
    }

    /// @param metadata abi.encodePacked(workflowId, workflowName, workflowOwner) as the real forwarder would send
    function forward(address receiver, bytes calldata metadata, bytes calldata report) external {
        if (msg.sender != operator) revert NotOperator();
        IReceiver(receiver).onReport(metadata, report);
    }
}
