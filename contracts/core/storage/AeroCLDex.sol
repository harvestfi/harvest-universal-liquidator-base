// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

abstract contract AeroCLDexStorage {
    mapping(address => mapping(address => int24)) internal _tickSpacing;
}
