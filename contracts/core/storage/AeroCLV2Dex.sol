// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

abstract contract AeroCLV2DexStorage {
    mapping(address => mapping(address => int24)) internal _tickSpacing;
}
