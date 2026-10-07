#!/usr/bin/env bash
pkill -f "services/source/src/server.ts"; pkill -f "services/verifier/src/server.ts"; pkill -f "agents/buyer/src/server.ts"; pkill -f "^anvil"; echo stopped
