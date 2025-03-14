#!/usr/bin/env bash

CURRENT_DIR=$(pwd)

# This script assumes that you've started a hardhat node fork of Ethereum mainnet, and makes requests to the fork that
# modify it in preparation for running test scripts connected to it. For example, running `impersonateAccounts` unlocks
# accounts that we'll use to submit and vote on Admin proposals.
HARDHAT_NETWORK=localhost yarn hardhat run $CURRENT_DIR/packages/scripts/utils/impersonateAccounts.js --no-compile
