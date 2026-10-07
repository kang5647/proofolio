// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {Script, console} from "forge-std/Script.sol";
import {ResumeReceipt} from "../src/ResumeReceipt.sol";
import {MockForwarder} from "../src/MockForwarder.sol";

/// Usage:
///   Sepolia (real Chainlink KeystoneForwarder):
///     FORWARDER=0x15fc6ae953e024d975e77382eeec56a9101f9f88 forge script script/Deploy.s.sol:DeployReceipt --rpc-url $SEPOLIA_RPC_URL --broadcast --private-key $SEPOLIA_PRIVATE_KEY
///   Local anvil (mock forwarder, operator = deployer):
///     forge script script/Deploy.s.sol:DeployLocal --rpc-url http://127.0.0.1:8545 --broadcast --private-key $ANVIL_KEY
contract DeployReceipt is Script {
    function run() external {
        address forwarder = vm.envAddress("FORWARDER");
        vm.startBroadcast();
        ResumeReceipt rr = new ResumeReceipt(forwarder);
        vm.stopBroadcast();
        console.log("RESUME_RECEIPT=%s", address(rr));
    }
}

contract DeployLocal is Script {
    function run() external {
        vm.startBroadcast();
        MockForwarder fwd = new MockForwarder(msg.sender);
        ResumeReceipt rr = new ResumeReceipt(address(fwd));
        vm.stopBroadcast();
        console.log("MOCK_FORWARDER=%s", address(fwd));
        console.log("RESUME_RECEIPT=%s", address(rr));
    }
}
