// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

abstract contract AerodromeDexStorage {
    mapping(address => mapping(address => bool)) internal _pairStable;
    mapping(address => mapping(address => address)) internal _pairFactory;
}
